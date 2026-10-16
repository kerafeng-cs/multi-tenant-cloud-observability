# Lab environment (not part of the product)

The lab cluster has no enterprise DNS and no entry point. This folder
simulates them so MTCO can be tested with its real public names
(`docs/install-requirements.md`).

- `lab-edge`: an nginx in namespace `mtco-lab` that routes
  `keycloak.mtco.test`, `grafana.mtco.test`, `mtco.test` and
  `otel.mtco.test` to the MTCO Services (like the enterprise ingress).
- Name resolution: hosts-file entries on the machines you test from,
  pointing to a `kubectl port-forward` of `lab-edge` on port 80.

Apply after the product (nginx resolves its upstreams at start):

```bash
kubectl apply -k environment/lab
kubectl -n mtco-lab rollout status deploy/lab-edge
```

Expose it on port 80 of the machine running kubectl (port 80 needs root):

```bash
sudo "$(command -v kubectl)" --kubeconfig "$HOME/.kube/config" \
  -n mtco-lab port-forward --address 0.0.0.0 svc/lab-edge 80:80
```

Hosts-file line (Windows: `C:\Windows\System32\drivers\etc\hosts` as
administrator; WSL and Linux: `/etc/hosts`; a VM: the IP of the machine
running the port-forward instead of 127.0.0.1):

```
127.0.0.1 keycloak.mtco.test grafana.mtco.test mtco.test otel.mtco.test
```

Workloads in other namespaces of the cluster do not need any of this:
they use the in-cluster Service names (see `docs/install-requirements.md`).
