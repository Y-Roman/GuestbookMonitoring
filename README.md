# Guestbook Application with Prometheus & Grafana Monitoring

A Kubernetes Guestbook application deployed with Pulumi, monitored by Prometheus and visualised in Grafana.

## Architecture

```
┌─────────────────────── Kubernetes (Docker Desktop) ────────────────────────┐
│                                                                              │
│  namespace: guestbook                  namespace: monitoring                 │
│  ┌─────────────────────┐              ┌──────────────────────────────────┐  │
│  │  frontend (PHP)     │◄─:30080      │  Prometheus  ← scrapes kubelet   │  │
│  │  NodePort :30080    │              │  Grafana     ← NodePort :30300   │  │
│  └─────────┬───────────┘              │  kube-state-metrics              │  │
│            │ reads/writes             └──────────────────────────────────┘  │
│  ┌─────────▼───────────┐                          ↑                         │
│  │  redis-master       │          kubelet/cAdvisor scrapes all containers   │
│  └─────────────────────┘                                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Monitoring flow:** Kubernetes's built-in kubelet/cAdvisor collects CPU, memory, and network metrics for every container automatically. Prometheus scrapes these from the kubelet endpoint every 15 seconds. Grafana queries Prometheus and renders charts.

---

## Prerequisites

| Tool | Install |
|------|---------|
| Docker Desktop (Kubernetes enabled) | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| kubectl | bundled with Docker Desktop |
| Pulumi | `brew install pulumi` |
| Helm | `brew install helm` |
| Node.js ≥ 18 | [nodejs.org](https://nodejs.org) |

**Enable Kubernetes in Docker Desktop:**
Settings → Kubernetes → Enable Kubernetes → Apply & Restart.
Wait for the green Kubernetes indicator at the bottom of the Docker Desktop window.

---

## Deploy

```bash
# 1. Clone the repo
git clone git@github.com:Y-Roman/GuestbookMonitoring.git
cd GuestbookMonitoring

# 2. Install Node dependencies
npm install

# 3. Use local Pulumi state (no Pulumi account required)
pulumi login --local
export PULUMI_CONFIG_PASSPHRASE=""

# 4. Deploy everything to Kubernetes
pulumi up --yes
```

Pulumi creates 9 resources and prints access details when done (~30–60 seconds).

---

## Access Details

| Service | URL | Credentials |
|---------|-----|-------------|
| Guestbook app | http://localhost:30080 | — |
| Grafana | http://localhost:30300 | `admin` / `admin123` |

Retrieve these at any time with:

```bash
PULUMI_CONFIG_PASSPHRASE="" pulumi stack output
```

---

## Grafana Dashboards

Two dashboards load automatically after deploy:

1. **Guestbook Application Metrics** — custom dashboard with CPU, memory, and network I/O broken down by guestbook pod.
2. **Kubernetes Cluster** — community dashboard with cluster-wide overview.

Navigate to: Grafana → Dashboards → Browse → *Guestbook Application Metrics*

---

## How to Verify Prometheus Is Scraping Guestbook Metrics

### Option 1 — PromQL query in the Prometheus UI

```bash
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090
```

Open **http://localhost:9090/graph** and run either query:

```promql
# Memory usage per guestbook pod
container_memory_usage_bytes{namespace="guestbook"}

# CPU rate per guestbook pod (5-minute average)
sum(rate(container_cpu_usage_seconds_total{namespace="guestbook", container!=""}[5m])) by (pod)
```

Results confirm Prometheus holds live data for the guestbook pods.

### Option 2 — Prometheus Targets page

With the port-forward open, visit **http://localhost:9090/targets**.
Look for the `kubelet` job — it lists every node's cAdvisor endpoint as `UP`,
which is what feeds the guestbook container metrics.

### Option 3 — Grafana

Open the **Guestbook Application Metrics** dashboard.
If the CPU, Memory, and Network I/O panels show data (not "No data"), Prometheus is collecting guestbook metrics successfully.

---

## Teardown

```bash
PULUMI_CONFIG_PASSPHRASE="" pulumi destroy --yes
```

---

## Project Structure

```
.
├── index.ts          # All infrastructure as code (Pulumi + TypeScript)
├── Pulumi.yaml       # Project name and runtime declaration
├── Pulumi.dev.yaml   # Stack-level config for the dev environment
├── package.json      # Node.js dependencies (@pulumi/kubernetes)
└── tsconfig.json     # TypeScript compiler options
```
