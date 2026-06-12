import * as k8s from "@pulumi/kubernetes";

// ============================================================
// NAMESPACES
// A "namespace" in Kubernetes is like a folder — it keeps
// related resources grouped together so they don't clash.
// We use one namespace for the app, one for monitoring tools.
// ============================================================

const appNamespace = new k8s.core.v1.Namespace("guestbook-ns", {
    metadata: { name: "guestbook" },
});

const monitoringNamespace = new k8s.core.v1.Namespace("monitoring-ns", {
    metadata: { name: "monitoring" },
});

// ============================================================
// REDIS BACKEND
// The Guestbook app stores its data in Redis (a fast in-memory
// database). We deploy a Redis "master" (primary writer) here.
//
// Key Kubernetes concepts used:
//   Deployment — manages N identical copies (replicas) of a Pod
//   Service     — gives the Deployment a stable network address
//                 so other Pods can find it by name
// ============================================================

const redisLabels = { app: "redis", role: "master" };

const redisMasterDeployment = new k8s.apps.v1.Deployment("redis-master", {
    metadata: { namespace: "guestbook" },
    spec: {
        selector: { matchLabels: redisLabels },
        replicas: 1,
        template: {
            metadata: { labels: redisLabels },
            spec: {
                containers: [{
                    name: "redis",
                    image: "redis:6",
                    ports: [{ containerPort: 6379 }],
                    resources: {
                        requests: { cpu: "100m", memory: "100Mi" },
                        limits:   { cpu: "200m", memory: "200Mi" },
                    },
                }],
            },
        },
    },
}, { dependsOn: appNamespace });

const redisMasterService = new k8s.core.v1.Service("redis-master-svc", {
    metadata: { name: "redis-master", namespace: "guestbook" },
    spec: {
        selector: redisLabels,
        ports: [{ port: 6379, targetPort: 6379 }],
    },
}, { dependsOn: redisMasterDeployment });

// The frontend v5 image looks for "redis-follower" for reads.
// We point it at the same Redis master since this is a single-node dev setup.
const redisFollowerService = new k8s.core.v1.Service("redis-follower-svc", {
    metadata: { name: "redis-follower", namespace: "guestbook" },
    spec: {
        selector: redisLabels,
        ports: [{ port: 6379, targetPort: 6379 }],
    },
}, { dependsOn: redisMasterDeployment });

// ============================================================
// GUESTBOOK FRONTEND
// A simple PHP app that lets users post messages.
// We annotate it with prometheus.io/scrape so Prometheus knows
// to collect metrics from it (like CPU, memory usage).
//
// The "prometheus.io/scrape" annotation is Prometheus's way of
// discovering which services to monitor — it's like putting a
// sign on the door saying "health inspector welcome here".
// ============================================================

const frontendLabels = { app: "guestbook", tier: "frontend" };

const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    metadata: { namespace: "guestbook" },
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 1,
        template: {
            metadata: {
                labels: frontendLabels,
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port":   "80",
                    "prometheus.io/path":   "/",
                },
            },
            spec: {
                containers: [{
                    name:  "php-redis",
                    image: "us-docker.pkg.dev/google-samples/containers/gke/gb-frontend:v5",
                    ports: [{ containerPort: 80 }],
                    env: [{
                        name:  "GET_HOSTS_FROM",
                        value: "dns",
                    }],
                    resources: {
                        requests: { cpu: "100m", memory: "100Mi" },
                        limits:   { cpu: "500m", memory: "256Mi" },
                    },
                }],
            },
        },
    },
}, { dependsOn: [appNamespace, redisMasterService] });

// NodePort exposes the frontend on a port directly on the host
// machine (Docker Desktop), so you can open it in your browser.
const frontendService = new k8s.core.v1.Service("frontend-svc", {
    metadata: {
        name: "frontend",
        namespace: "guestbook",
        annotations: {
            "prometheus.io/scrape": "true",
            "prometheus.io/port":   "80",
        },
    },
    spec: {
        type:     "NodePort",
        selector: frontendLabels,
        ports: [{ port: 80, targetPort: 80, nodePort: 30080 }],
    },
}, { dependsOn: frontendDeployment });

// ============================================================
// PROMETHEUS + GRAFANA (via Helm)
// Prometheus is a monitoring system. It "scrapes" (polls) your
// services every few seconds and stores the numbers in a
// time-series database (CPU%, request counts, memory, etc.).
//
// Grafana reads from Prometheus and draws charts.
// Think: Prometheus = the database, Grafana = the dashboard.
//
// We install both using the "kube-prometheus-stack" Helm chart.
// A Helm chart is a pre-packaged bundle — like an npm package
// but for Kubernetes infrastructure.
// ============================================================

const prometheusStack = new k8s.helm.v3.Release("prometheus-stack", {
    name:            "prometheus-stack",
    chart:           "kube-prometheus-stack",
    version:         "61.9.0",
    namespace:       "monitoring",
    repositoryOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    values: {
        alertmanager:  { enabled: false },
        nodeExporter:  { enabled: false },

        prometheus: {
            prometheusSpec: {
                // Scrape pods across ALL namespaces (including guestbook)
                podMonitorNamespaceSelector:     { matchLabels: {} },
                serviceMonitorNamespaceSelector: { matchLabels: {} },
                // Pick up any pod annotated with prometheus.io/scrape=true
                additionalScrapeConfigs: [{
                    job_name: "guestbook-frontend",
                    kubernetes_sd_configs: [{
                        role: "pod",
                        namespaces: { names: ["guestbook"] },
                    }],
                    relabel_configs: [
                        {
                            source_labels: ["__meta_kubernetes_pod_annotation_prometheus_io_scrape"],
                            action: "keep",
                            regex: "true",
                        },
                        {
                            source_labels: ["__meta_kubernetes_pod_annotation_prometheus_io_path"],
                            action: "replace",
                            target_label: "__metrics_path__",
                            regex: "(.+)",
                        },
                        {
                            source_labels: ["__address__", "__meta_kubernetes_pod_annotation_prometheus_io_port"],
                            action: "replace",
                            target_label: "__address__",
                            regex: "([^:]+)(?::\\d+)?;(\\d+)",
                            replacement: "$1:$2",
                        },
                    ],
                }],
            },
        },

        grafana: {
            enabled:       true,
            adminPassword: "admin123",

            service: {
                type:     "NodePort",
                nodePort: 30300,
            },

            // Install a pre-built Kubernetes overview dashboard
            dashboardProviders: {
                "dashboardproviders.yaml": {
                    apiVersion: 1,
                    providers: [{
                        name:            "default",
                        orgId:           1,
                        folder:          "",
                        type:            "file",
                        disableDeletion: false,
                        editable:        true,
                        options: { path: "/var/lib/grafana/dashboards/default" },
                    }],
                },
            },
            dashboards: {
                default: {
                    "kubernetes-cluster": {
                        gnetId:     6417,
                        revision:   1,
                        datasource: "Prometheus",
                    },
                },
            },
        },
    },
    timeout: 600,
}, { dependsOn: monitoringNamespace });

// ============================================================
// OUTPUTS
// Pulumi prints these after a successful deploy — this is how
// the assignment requirement "output Grafana access details"
// is satisfied.
// ============================================================

export const guestbookUrl   = "http://localhost:30080";
export const grafanaUrl      = "http://localhost:30300";
export const grafanaUser     = "admin";
export const grafanaPassword = "admin123";
export const instructions    = [
    "1. Open the Guestbook at http://localhost:30080",
    "2. Open Grafana at http://localhost:30300",
    "3. Log in with admin / admin123",
    "4. Dashboards → Browse → Kubernetes Cluster",
];
