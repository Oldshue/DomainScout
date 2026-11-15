import { defineRailway, github, project, service, volume } from "railway/iac";

// This repository owns the DomainScout service and its attached durable volume.
// Variables stay managed in Railway so secret values never enter source control.
export const partial = "domainscout";

export default defineRailway(() => {
  const domainscoutVolume = volume("domainscout-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 160000 });
  const domainscout = service("domainscout", {
    source: github("Oldshue/DomainScout", { branch: "master", checkSuites: true }),
    build: { buildEnvironment: "V3", builder: "NIXPACKS" },
    start: "node scripts/railway-boot-cleanup.js && node server/index.js",
    healthcheck: "/api/stats",
    healthcheckTimeout: 600,
    replicas: { "us-west2": 1 },
    deploy: {
      ipv6EgressEnabled: false,
      limitOverride: { containers: { cpu: 8, memoryBytes: 12000000000 } },
      restartPolicyMaxRetries: 5,
      restartPolicyType: "ON_FAILURE",
      runtime: "V2",
      useLegacyStacker: false,
    },
    volumeMounts: { "/data": domainscoutVolume },
  });

  return project("DomainScout", {
    variables: { managed: false },
    resources: [domainscout, domainscoutVolume],
  });
});
