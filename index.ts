import * as k8s from "@pulumi/kubernetes";

// ============================================================
// NAMESPACES
// A "namespace" in Kubernetes is like a folder — it keeps
// related resources grouped together so they don't clash.
// ============================================================

const appNamespace = new k8s.core.v1.Namespace("guestbook-ns", {
    metadata: { name: "guestbook" },
});

const monitoringNamespace = new k8s.core.v1.Namespace("monitoring-ns", {
    metadata: { name: "monitoring" },
});

// ============================================================
// REDIS BACKEND
// The Guestbook stores messages in Redis (an in-memory database).
//
//   Deployment — manages N identical Pod replicas, restarts on crash
//   Service    — gives a Deployment a stable DNS name inside the cluster
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
                    name:  "redis",
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

// The gb-frontend:v5 image expects two named Redis services:
// "redis-master" (writes) and "redis-follower" (reads).
// For this single-node dev setup both point to the same pod.
const redisFollowerService = new k8s.core.v1.Service("redis-follower-svc", {
    metadata: { name: "redis-follower", namespace: "guestbook" },
    spec: {
        selector: redisLabels,
        ports: [{ port: 6379, targetPort: 6379 }],
    },
}, { dependsOn: redisMasterDeployment });

// ============================================================
// GUESTBOOK FRONTEND
// A PHP app where users post messages.
//
// prometheus.io annotations tell Prometheus's pod discovery to
// include this pod when it scans for targets to scrape.
// Container CPU/memory metrics are collected automatically by
// kubelet/cAdvisor regardless of these annotations.
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
                    "prometheus.io/path":   "/metrics",
                },
            },
            spec: {
                containers: [{
                    name:  "php-redis",
                    image: "us-docker.pkg.dev/google-samples/containers/gke/gb-frontend:v5",
                    ports: [{ containerPort: 80 }],
                    env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                    resources: {
                        requests: { cpu: "100m", memory: "100Mi" },
                        limits:   { cpu: "500m", memory: "256Mi" },
                    },
                }],
            },
        },
    },
}, { dependsOn: [appNamespace, redisMasterService] });

const frontendService = new k8s.core.v1.Service("frontend-svc", {
    metadata: { name: "frontend", namespace: "guestbook" },
    spec: {
        type:     "NodePort",
        selector: frontendLabels,
        ports: [{ port: 80, targetPort: 80, nodePort: 30080 }],
    },
}, { dependsOn: frontendDeployment });

// ============================================================
// CUSTOM GRAFANA DASHBOARD — Guestbook Application Metrics
//
// Grafana can load dashboards from Kubernetes ConfigMaps
// automatically via its sidecar container. Any ConfigMap with
// the label "grafana_dashboard=1" in the monitoring namespace
// gets picked up and loaded as a dashboard.
//
// The dashboard uses PromQL queries against metrics that
// kubelet/cAdvisor collects for every container automatically:
//   container_cpu_usage_seconds_total  — CPU time consumed
//   container_memory_usage_bytes       — RAM in use
//   container_network_*_bytes_total    — network traffic
//   kube_pod_info                      — pod metadata
// ============================================================

const guestbookDashboard = {
    title: "Guestbook Application Metrics",
    uid:   "guestbook-app-metrics",
    tags:  ["guestbook", "kubernetes"],
    timezone: "browser",
    schemaVersion: 38,
    refresh: "30s",
    time: { from: "now-1h", to: "now" },
    templating: {
        list: [{
            name:        "datasource",
            type:        "datasource",
            query:       "prometheus",
            label:       "Datasource",
            hide:        0,
            includeAll:  false,
            multi:       false,
            current:     { text: "Prometheus", value: "Prometheus" },
        }],
    },
    panels: [
        {
            id: 1, type: "stat", title: "Running Pods",
            gridPos: { x: 0, y: 0, w: 6, h: 4 },
            datasource: { type: "prometheus", uid: "${datasource}" },
            targets: [{
                expr: 'count(kube_pod_info{namespace="guestbook"})',
                legendFormat: "Pods",
            }],
            options: { colorMode: "value", graphMode: "none", justifyMode: "center" },
        },
        {
            id: 2, type: "stat", title: "Container Restarts (1h)",
            gridPos: { x: 6, y: 0, w: 6, h: 4 },
            datasource: { type: "prometheus", uid: "${datasource}" },
            targets: [{
                expr: 'sum(increase(kube_pod_container_status_restarts_total{namespace="guestbook"}[1h]))',
                legendFormat: "Restarts",
            }],
            options: { colorMode: "value", graphMode: "none", justifyMode: "center" },
        },
        {
            id: 3, type: "stat", title: "CPU Usage (cores)",
            gridPos: { x: 12, y: 0, w: 6, h: 4 },
            datasource: { type: "prometheus", uid: "${datasource}" },
            targets: [{
                expr: 'sum(rate(container_cpu_usage_seconds_total{namespace="guestbook",container!="",container!="POD"}[5m]))',
                legendFormat: "CPU",
            }],
            options: { colorMode: "value", graphMode: "none", justifyMode: "center" },
            fieldConfig: { defaults: { unit: "short", decimals: 3 } },
        },
        {
            id: 4, type: "stat", title: "Memory Usage",
            gridPos: { x: 18, y: 0, w: 6, h: 4 },
            datasource: { type: "prometheus", uid: "${datasource}" },
            targets: [{
                expr: 'sum(container_memory_usage_bytes{namespace="guestbook",container!="",container!="POD"})',
                legendFormat: "Memory",
            }],
            options: { colorMode: "value", graphMode: "none", justifyMode: "center" },
            fieldConfig: { defaults: { unit: "bytes" } },
        },
        {
            id: 5, type: "timeseries", title: "CPU Usage by Pod",
            gridPos: { x: 0, y: 4, w: 12, h: 8 },
            datasource: { type: "prometheus", uid: "${datasource}" },
            targets: [{
                expr: 'sum(rate(container_cpu_usage_seconds_total{namespace="guestbook",container!="",container!="POD"}[5m])) by (pod)',
                legendFormat: "{{pod}}",
            }],
            fieldConfig: { defaults: { unit: "short", custom: { lineWidth: 2 } } },
        },
        {
            id: 6, type: "timeseries", title: "Memory Usage by Pod",
            gridPos: { x: 12, y: 4, w: 12, h: 8 },
            datasource: { type: "prometheus", uid: "${datasource}" },
            targets: [{
                expr: 'sum(container_memory_usage_bytes{namespace="guestbook",container!="",container!="POD"}) by (pod)',
                legendFormat: "{{pod}}",
            }],
            fieldConfig: { defaults: { unit: "bytes", custom: { lineWidth: 2 } } },
        },
        {
            id: 7, type: "timeseries", title: "Network I/O by Pod",
            gridPos: { x: 0, y: 12, w: 24, h: 8 },
            datasource: { type: "prometheus", uid: "${datasource}" },
            targets: [
                {
                    expr: 'sum(rate(container_network_receive_bytes_total{namespace="guestbook"}[5m])) by (pod)',
                    legendFormat: "RX {{pod}}",
                },
                {
                    expr: 'sum(rate(container_network_transmit_bytes_total{namespace="guestbook"}[5m])) by (pod)',
                    legendFormat: "TX {{pod}}",
                },
            ],
            fieldConfig: { defaults: { unit: "Bps", custom: { lineWidth: 2 } } },
        },
    ],
};

// ============================================================
// PROMETHEUS + GRAFANA (via Helm — kube-prometheus-stack)
//
// Prometheus "scrapes" HTTP endpoints every 15s and stores the
// numbers in a time-series database.
// Grafana reads from Prometheus and renders charts.
//
// kube-prometheus-stack installs both plus:
//   - kube-state-metrics  (pod/deployment state metrics)
//   - prometheus-operator (manages Prometheus config via CRDs)
// ============================================================

const prometheusStack = new k8s.helm.v3.Release("prometheus-stack", {
    name:    "prometheus-stack",
    chart:   "kube-prometheus-stack",
    version: "61.9.0",
    namespace: "monitoring",
    repositoryOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    values: {
        alertmanager: { enabled: false },
        nodeExporter: { enabled: false },

        prometheus: {
            prometheusSpec: {
                // Monitor resources in ALL namespaces, not just "monitoring"
                podMonitorNamespaceSelector:     { matchLabels: {} },
                serviceMonitorNamespaceSelector: { matchLabels: {} },
                ruleNamespaceSelector:           { matchLabels: {} },
            },
        },

        grafana: {
            enabled:       true,
            adminPassword: "admin123",

            service: {
                type:     "NodePort",
                nodePort: 30300,
            },

            // Enable the sidecar that watches for dashboard ConfigMaps
            sidecar: {
                dashboards: {
                    enabled:         true,
                    label:           "grafana_dashboard",
                    labelValue:      "1",
                    searchNamespace: "monitoring",
                },
            },

            // Pre-load the community Kubernetes overview dashboard
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
// Pulumi prints these after every successful deploy.
// Run `pulumi stack output` at any time to see them again.
// ============================================================

// Load the custom Guestbook dashboard into Grafana.
// The Grafana sidecar watches for ConfigMaps labelled grafana_dashboard=1
// and mounts them automatically — no Grafana restart needed.
const dashboardConfigMap = new k8s.core.v1.ConfigMap("guestbook-dashboard-cm", {
    metadata: {
        name:      "guestbook-dashboard",
        namespace: "monitoring",
        labels:    { grafana_dashboard: "1" },
    },
    data: {
        "guestbook.json": JSON.stringify(guestbookDashboard),
    },
}, { dependsOn: prometheusStack });

export const guestbookUrl   = "http://localhost:30080";
export const grafanaUrl      = "http://localhost:30300";
export const grafanaUser     = "admin";
export const grafanaPassword = "admin123";
export const instructions    = [
    "1. Guestbook app  →  http://localhost:30080",
    "2. Grafana        →  http://localhost:30300  (admin / admin123)",
    "3. Prometheus UI  →  kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090",
    "4. In Grafana: Dashboards → Browse → Guestbook Application Metrics",
];
