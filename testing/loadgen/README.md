# TODO-20 — hạm đội host tổng hợp

Mặc định **100 host/pod**, 100 host toàn lượt, chạy 10 phút. Một Indexed Job chia host theo chỉ số pod; mỗi host có `host.name` và số liệu riêng. Đây là tải ghi OTLP/HTTP JSON đi qua Keycloak → otel-gateway → VictoriaMetrics/OpenSearch thật. Không lấy CPU/RAM của node rồi nhân bản thành nhiều máy.

Một lượt chạy đăng ký **một agent thật cho một tenant**, các worker dùng chung credential của agent đó. Vì vậy 10.000 host không đồng nghĩa 10.000 agent hay 10.000 phiên OAuth. Nhiều tenant dùng nhiều lượt có tên khác nhau. Công cụ này không thay thế benchmark enrollment, agent trên VMware, collector thật hoặc tải đọc query-gateway.

Mã chỉ ở `testing/loadgen/`, không tham gia overlay triển khai nền tảng. Không sửa claims, issuer, bootstrap, gateway, database hay dashboard; không thay các bản nháp `testing/fleet/` và `testing/telemetrygen/`.

## Cách triển khai

Máy vận hành cần Node **22 trở lên** và kubectl đã cấu hình đúng cluster. Không có npm package, bước build hay image riêng. Pod dùng `node:22.19.0-alpine`; cluster cần truy cập registry hoặc dùng `--image` trỏ đến bản Node 22+ trong registry nội bộ. Khi dùng lâu dài, nên truyền image đã được tổ chức duyệt, có digest. Công cụ không tự cài gì trên máy vận hành.

Các ví dụ dưới đây chạy từ gốc repo, trong WSL/Bash. Mật khẩu được hỏi kín; không truyền qua tham số, môi trường hoặc file. Tài khoản phải có quyền platform-admin hoặc tenant-admin của tenant đã tồn tại.

1. Kiểm thử và xem kế hoạch, chưa tác động cluster:

```bash
node --version
node --test testing/loadgen/loadgen.test.mjs
node testing/loadgen/fleet.mjs plan --run smoke --tenant alpha-tenant --hosts 100
```

Nếu Node hiện có thấp hơn 22, dừng tại đây và chuẩn bị runtime phù hợp trước; không có lệnh tự cài đi kèm. Bộ test dùng HTTP loopback giả lập và Kubernetes adapter giả, không gọi kubectl hay cluster.

2. Nếu đang dùng truy cập dev qua port-forward, mở hai terminal WSL riêng, mỗi terminal chạy một lệnh. Không cần mở lại nếu các cổng này đã được forward:

```bash
kubectl -n observability port-forward --address 0.0.0.0 svc/keycloak 8080:8080
```

```bash
kubectl -n observability port-forward --address 0.0.0.0 svc/control-plane 18081:8080
```

Để dừng đúng port-forward:

```bash
pkill -f "port-forward.*svc/keycloak"
pkill -f "port-forward.*svc/control-plane"
```

3. Trong terminal chạy CLI, nhập tenant thật và **token URL đầy đủ mà pod truy cập được**, rồi triển khai canary:

```bash
read -r -p 'Tenant đang tồn tại: ' MTCO_LOAD_TENANT
read -r -p 'Token URL Keycloak truy cập từ pod: ' MTCO_LOAD_TOKEN_URL
node testing/loadgen/fleet.mjs deploy --run smoke \
  --tenant "$MTCO_LOAD_TENANT" --hosts 100 --hosts-per-pod 100 \
  --token-url "$MTCO_LOAD_TOKEN_URL" \
  --gateway-url http://otel-gateway.observability.svc.cluster.local:4318 \
  --allow-http
```

Token URL có đường dẫn `/realms/observability/protocol/openid-connect/token`. URL này phải trả token có `iss` **đúng bằng** `platform-endpoints.KEYCLOAK_ISSUER`. Khi chưa làm TODO-04, gọi `keycloak:8080` có thể sinh `iss` khác và sẽ bị chặn. Không dùng `localhost` làm token URL cho pod; không ghi đè Host hoặc sửa JWT để vượt qua kiểm tra. Công cụ không sửa được đường mạng hoặc issuer chưa thống nhất. Có thể kiểm tra issuer không chứa secret bằng:

```bash
kubectl -n observability get configmap platform-endpoints -o jsonpath='{.data.KEYCLOAK_ISSUER}{"\n"}'
```

`--api-url` và `--keycloak-url` phục vụ máy vận hành, mặc định lần lượt là `http://localhost:18081` và `http://localhost:8080`. `--token-url` và `--gateway-url` phục vụ **pod**, mặc định lấy từ enrollment response. `--issuer` chỉ thay giá trị kỳ vọng trong probe, không cấu hình lại Keycloak/gateway; thông thường để công cụ đọc ConfigMap. `--namespace` mặc định `observability`.

HTTPS được kiểm chứng bằng trust store của Node; HTTP phải bật rõ `--allow-http` cho môi trường dev. Chưa có cờ mount CA nội bộ riêng: dùng image đã chứa CA của tổ chức nếu cần; không tắt xác minh TLS. Mạng bị NetworkPolicy hạn chế cần cho worker đi DNS, Keycloak và OTLP; công cụ không tự nới policy.

Luồng deploy:

1. Kiểm tra tham số, ngân sách pod, tên lượt và issuer.
2. Đăng nhập bằng `mtco-cli`; tạo enrollment qua `/api/v1/tenants/.../agent-enrollments` và exchange bằng API hiện tại.
3. Lưu token enrollment trước exchange trong Secret có nhãn sở hữu; sau exchange thay bằng credential agent. Mật khẩu/token quản trị chỉ ở RAM của CLI, không đưa vào pod. Secret đi qua stdin của kubectl, không qua tham số, file tạm hay annotation last-applied.
4. Tạo ConfigMap bất biến chứa mã worker và cấu hình; chạy một probe pod gửi metrics của một host và một log. Probe dùng OAuth thật, kiểm tra issuer/tenant/agent/audience/VM account claim; gateway vẫn chịu trách nhiệm xác minh chữ ký JWT.
5. Chỉ khi probe Job thành công mới tạo Job tải. Probe lỗi thì không tạo Job tải; Secret vẫn được giữ để xử lý hoặc cleanup. Probe có ghi một ít dữ liệu thật.

Probe thành công chỉ chứng minh gateway **chấp nhận request**, chưa chứng minh exporter đã ghi thành công hoặc Grafana đọc được dữ liệu. Checklist cuối tài liệu là bước bắt buộc trước khi tăng tải.

## Giới hạn và tăng tải

| Host | Pod (100 host/pod) | CPU/RAM requests của generator | CPU/RAM limits tổng | Metric points/s mặc định | Chu kỳ mỗi host |
|---:|---:|---:|---:|---:|---:|
| 100 | 1 | 50m / 64Mi | 250m / 128Mi | 66,7 | 15 giây |
| 1.000 | 10 | 500m / 640Mi | 2.500m / 1.280Mi | 500 | 20 giây |
| 10.000 | 100 | 5.000m / 6.400Mi | 25.000m / 12.800Mi | 500 | 200 giây |

Số đo cluster người dùng cung cấp ngày 2026-10-13: 2 node, tổng 8 CPU và khoảng 15,5 GiB RAM; requests hiện có khoảng 3,57 CPU và 7,28 GiB RAM, limits đã vượt dung lượng. Metrics API chưa có, nên đây là **dung lượng và tài nguyên đặt trước**, không phải tải thực tế. Thêm 100 pod theo bảng sẽ vượt phần CPU requests còn lại. Không triển khai 10.000 host trên cluster này chỉ vì công cụ cho phép cấu hình.

Các tham số độc lập:

- `--hosts`: tổng host; `--hosts-per-pod`: mật độ, mặc định 100, tối đa 1.000.
- `--metric-interval`: chu kỳ mục tiêu mỗi host, mặc định 15 giây. Mỗi host có 10 data point/chu kỳ, khoảng 10 series trước các series phụ do exporter tạo.
- `--metric-points-per-second`: ngân sách **toàn lượt**, mặc định 500. Chu kỳ thực dùng là giá trị lớn hơn giữa chu kỳ yêu cầu và tổng points chia ngân sách.
- `--logs-per-second`: log/s **toàn lượt**, mặc định 5; đặt 0 để chỉ sinh metrics. Probe vẫn kiểm tra cả hai pipeline.
- `--duration`: thời gian gửi mỗi worker, mặc định 600 giây; `--ramp`: giãn thời điểm bắt đầu giữa worker, mặc định 30 giây.
- `--max-pods`: ngưỡng chặn trước deploy, mặc định 10. Tăng ngưỡng là quyết định của người vận hành sau khi kiểm tra dung lượng, không tự động scale cluster.

Tốc độ là mục tiêu trung bình, có burst nhỏ theo batch, không phải trần tuyệt đối từng giây. Mỗi pod tối đa một request metrics và một request logs đồng thời; batch metrics tối đa 10 host/100 points, batch logs tối đa 10 bản ghi. Khi receiver chậm, tốc độ thực giảm, không tích hàng đợi hoặc gửi bù. Lỗi tạm thời bỏ batch, backoff giới hạn, dừng worker sau 5 lỗi liên tiếp ở một pipeline; lỗi quyền/claims và partial success dừng ngay. Batch timeout có thể đã đến server, nên được thống kê là không chắc chắn hoặc đã bỏ, không tự gửi lại.

Token được cache và refresh trước hạn, gộp yêu cầu refresh đồng thời trong mỗi pod. Không có điều phối OAuth toàn fleet; mỗi pod có cache riêng. Indexed Job dùng `backoffLimit: 0`, không tự phục hồi tải lỗi. Kubernetes vẫn có thể tạo trùng pod của một index trong một số sự cố: đây không phải bộ đo bảo đảm exactly-once.

Tăng theo nấc 100 → 300 → 1.000 sau khi hoàn thành checklist và đo nền tảng (TODO-25). Dừng lượt cũ trước; dùng tên lượt mới và cùng cấu hình endpoint đã qua probe. Xem trước 10.000 host mà không triển khai:

```bash
node testing/loadgen/fleet.mjs plan --run capacity --tenant alpha-tenant --hosts 10000
```

Kế hoạch trên báo `deployAllowed: false` vì vượt 10 pod. Nếu tăng ngưỡng sau này, cần xét cả tải gateway/storage, dung lượng đĩa và số series lịch sử, không chỉ tài nguyên của generator. Nhiều lượt chạy cộng dồn tốc độ. Tên lượt mới tạo host/series mới; cleanup không xóa telemetry đã lưu. Ở chu kỳ 200 giây, CPU/network cần cửa sổ `rate()` đủ dài (ví dụ 10 phút); dashboard dùng cửa sổ ngắn có thể trống dù dữ liệu đã được ghi. Với 5 log/s và 10.000 host, lượt 10 phút cũng không bảo đảm mọi host đều có log.

## Quan sát, dừng và cleanup

Các lệnh sau do người vận hành chạy:

```bash
node testing/loadgen/fleet.mjs status --run smoke
kubectl -n observability get pods -l 'app.kubernetes.io/managed-by=mtco-loadgen,mtco.test/run=smoke' -o wide
kubectl -n observability logs -l 'app.kubernetes.io/managed-by=mtco-loadgen,mtco.test/run=smoke' --all-containers=true --prefix=true --tail=30 --max-log-requests=10
node testing/loadgen/fleet.mjs stop --run smoke
```

Worker in thống kê sau mỗi 30 giây và khi kết thúc: `metricsAccepted`, `logsAccepted`, `failedBatches`, `uncertainOrDroppedItems`. “Accepted” là gateway ACK. Không log payload, token, credential hoặc response body lỗi. `stop` suspend các Job của lượt; Kubernetes chấm dứt pod, có thể còn request đang gửi trong thời gian kết thúc. Nó giữ agent, Secret và tài nguyên để điều tra. Không dùng lại tên lượt đã có Job tải.

Khi đã xem kết quả và muốn dọn **tài nguyên thử nghiệm của lượt smoke**, lệnh sau đăng nhập lại, suspend Job, thu hồi agent, rồi xóa đúng Job/ConfigMap/Secret có nhãn sở hữu của lượt. Nó không xóa file repo, namespace, PVC, index, tenant hay dữ liệu lịch sử:

```bash
node testing/loadgen/fleet.mjs cleanup --run smoke --allow-http
```

Nếu dùng URL đăng nhập khác localhost, truyền lại `--keycloak-url`; API URL của lượt được ghi trong annotation không chứa credential. Secret cần quyền RBAC hạn chế và chính sách mã hóa Secret của cluster; base64 tự nó không phải mã hóa. Không chạy `get secret -o yaml`, bật trace shell hoặc dán credential vào chat.

Exchange chỉ trả credential một lần. Nếu server commit rồi mất response, chạy deploy lại có thể gặp 410; công cụ **không tự đăng ký agent mới**. Cleanup dùng journal để tìm agent trong danh sách 100 enrollment mới nhất và thu hồi. Nếu enrollment đã trôi khỏi danh sách này, công cụ giữ journal và yêu cầu quản trị viên đối chiếu/thu hồi trước; không đoán và không xóa mù. Cleanup bị ngắt sau revoke có thể chạy lại. Xóa agent vẫn chịu độ trễ thu hồi JWT hiện tại (I-06); công cụ dừng pod trước khi revoke.

## Checklist E2E

- [ ] Chạy toàn bộ `node --test testing/loadgen/loadgen.test.mjs`: tất cả 18 test đạt. Test này chỉ dùng fake credential; không cần đăng nhập hoặc kubectl.
- [ ] Ghi nhận baseline: đăng nhập Grafana, `tools/mtco`, agent VMware đang gửi và query-gateway đang đọc bình thường. Lưu host VMware để so sánh sau thử nghiệm.
- [ ] Xác nhận tài nguyên cluster, disk còn trống và quan sát được lỗi/CPU/RAM của gateway/storage. Chưa có Metrics API thì chưa coi các số requests là đo hiệu năng; hoàn thiện TODO-25 trước thử tải lớn.
- [ ] Canary sai issuer: dùng tên lượt `badissuer`, cùng lệnh deploy nhưng thêm `--issuer http://invalid.invalid/realms/observability`. Probe phải thất bại, **không có Job tải `mtco-load-badissuer`**; logs không chứa token/secret. Sau đó cleanup riêng lượt `badissuer`.
- [ ] Canary đúng: deploy `smoke` 100 host, probe Complete trước khi Job tải xuất hiện. Một pod tải có giới hạn 250m/128Mi, không OOM hoặc restart. Kết thúc hữu hạn sau khoảng 10 phút cộng ramp/scheduling; không có vòng tự khởi động lại tải.
- [ ] Grafana đúng tenant → Explore VictoriaMetrics: `count(count by (host_name) (system_memory_usage_bytes{host_name=~"smoke-host-.*"}))` trả 100 khi lượt đang hoạt động và đã qua ít nhất một chu kỳ. Nếu exporter giữ tên không suffix, thay `system_memory_usage_bytes` bằng `system_memory_usage` (dashboard chấp nhận cả hai).
- [ ] Dashboard Hosts overview: dropdown có các host `smoke-host-000001` đến `smoke-host-000100`; CPU, RAM, load, network, filesystem có dữ liệu. Chờ ít nhất hai chu kỳ cho `rate()`. Metric không phụ thuộc CPU/RAM node thật.
- [ ] Explore OpenSearch qua datasource hiện có: tìm `resource.host.name.keyword:smoke-host-*`, kiểm tra log INFO/ERROR và các trường `resource.tenant.id`, `resource.agent.id` đã được gateway gắn (mapping được ghi ở `CLAUDE.md` §5). Probe ACK không đủ để bỏ qua bước này.
- [ ] Đăng nhập một tenant khác: không xem được metric/log của `smoke`; kiểm tra qua Grafana/query-gateway, không truy vấn kho bằng tài khoản admin để kết luận cách ly.
- [ ] Chạy lâu hơn TTL access token hiện tại (tăng `--duration` cho một lượt mới nếu cần): dữ liệu tiếp tục qua refresh, không có 401 hoặc burst tăng mạnh. Token giữ nguyên identity contract.
- [ ] Chạy `stop`: Job suspended, pod dừng; thống kê và timestamps không tiếp tục tăng sau thời gian kết thúc request/exporter. Host VMware thật vẫn có dữ liệu mới.
- [ ] Cleanup `smoke`: agent thử đã bị thu hồi, chỉ tài nguyên mang nhãn của lượt bị xóa; agent/tenant thật, database và dữ liệu đã ghi vẫn còn. Chạy lại cleanup không tạo agent mới.
- [ ] Sau canary, kiểm tra lại Grafana login, `tools/mtco`, VMware và query-gateway. Chỉ tăng lên 300/1.000 host khi ingest/exporter không báo lỗi, latency và dung lượng còn phù hợp. Ghi số đo thực tế trước mỗi lần tăng.

## Kiểm chứng tại máy phát triển

Ngày 2026-10-13: **14 test offline đạt** (chia 10.003 host, ngân sách, OTLP model, cache/claims/token, lỗi/partial response, backoff, dừng, ownership, Secret stdin, enrollment journal, probe gate, cleanup). Bốn test HTTP loopback chưa được xác nhận: sandbox trả `EACCES`, yêu cầu mở quyền kiểm thử bị từ chối. Chạy đầy đủ bộ test ở terminal của người dùng trước E2E; không coi kiểm thử giả lập là xác nhận collector/storage thật.

Lệnh chỉ chạy phần offline nếu môi trường chặn loopback:

```bash
node --test --test-skip-pattern='^\[http\]' testing/loadgen/loadgen.test.mjs
node testing/loadgen/benchmark.mjs
```

Benchmark encoder offline trên Node 22.19.0 Windows: một vòng 10.000 host tạo 100.000 points (~30 MB JSON) theo batch, khoảng 233 ms, RSS cao nhất quan sát ~43 MiB. Đây chỉ là phép kiểm tra encoder và bộ nhớ, **không phải** kết quả benchmark pod dưới CPU limit hay năng lực gateway/storage. Chưa chạy kubectl, container hoặc E2E cluster trong phiên này.

Tham chiếu protocol: [OTLP specification](https://opentelemetry.io/docs/specs/otlp/), [OpenTelemetry metrics protobuf](https://github.com/open-telemetry/opentelemetry-proto/blob/v1.9.0/opentelemetry/proto/metrics/v1/metrics.proto). Các cumulative sum, timestamp dạng chuỗi số và metric name được đối chiếu với dashboard cùng cấu hình gateway trong repo.
