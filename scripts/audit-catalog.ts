import { writeFileSync } from "node:fs";
import { ROLE_KEYS, ROLE_LABELS, PERMISSIONS, defaultPermissionsFor } from "../src/lib/permissions/definitions";
writeFileSync("docs/audit/evidence/permission-catalog.json", JSON.stringify({ roles: ROLE_KEYS.map((key) => ({ key, label: ROLE_LABELS[key], permissions: defaultPermissionsFor(key) })), permissions: PERMISSIONS }, null, 2));
