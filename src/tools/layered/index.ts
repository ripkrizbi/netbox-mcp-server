/**
 * The layered tool surface (RFC-003 D1).
 *
 * Five tools in four layers, replacing one tool per operation:
 *
 *   0. netbox_global_search  find an instance when the type is unknown
 *   1. netbox_discover       the object-type registry of this instance
 *   2. netbox_describe       fields, filters and prerequisites for one type
 *   3. netbox_read           list / get          (readOnlyHint)
 *      netbox_write          create / update / delete (destructiveHint)
 *
 * Layers 0-2 are metadata; only layer 3 acts. Read and write are separate
 * tools solely so their annotations can be true, which is worth one extra
 * tool in a surface of five.
 *
 * No tool takes a path. Every endpoint is resolved from `SchemaProvider`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { SchemaProvider } from "../../schema/types.js";
import { registerDescribe } from "./describe.js";
import { registerDiscover } from "./discover.js";
import { registerRead } from "./read.js";
import { registerLayeredSearch } from "./search.js";
import { registerWrite } from "./write.js";

export function registerLayeredTools(server: McpServer, schema: SchemaProvider): void {
  registerLayeredSearch(server, schema);
  registerDiscover(server, schema);
  registerDescribe(server, schema);
  registerRead(server, schema);
  registerWrite(server, schema);
}

export {
  registerDescribe,
  registerDiscover,
  registerRead,
  registerLayeredSearch,
  registerWrite,
};
