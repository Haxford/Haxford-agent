import { z, type ZodType } from "zod"

/**
 * Best-effort JSON Schema -> zod conversion for an MCP tool's `inputSchema`.
 *
 * MCP tool schemas are arbitrary JSON Schema, and zod cannot represent all of
 * it (oneOf/anyOf, $ref, complex numeric constraints, …). This handles the
 * shapes servers actually send in practice — object/properties/required and
 * the common scalar/array/nested-object leaves — and falls back to a
 * permissive schema for anything else, so a tool the model cannot fully
 * validate is still usable rather than unavailable.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string")
}

/**
 * How deep a server's schema may nest before we stop descending.
 *
 * The schema is supplied by the MCP server, and this conversion is
 * recursive: `{"type":"array","items":{"type":"array","items":…}}` nested
 * deep enough overflows the stack and takes the whole process down before a
 * single tool has been called. Real schemas are a handful of levels; past
 * this, the node becomes `z.unknown()` — permissive, which is what the
 * fallback already is everywhere else here, and finite.
 */
const MAX_SCHEMA_DEPTH = 32

function objectSchema(schema: Record<string, unknown>, depth: number): ZodType {
  const properties = schema["properties"]
  if (!isRecord(properties)) {
    // An object schema with no usable `properties` — accept any shape.
    return z.record(z.string(), z.unknown())
  }

  const required = new Set(stringList(schema["required"]))
  const shape: Record<string, ZodType> = {}
  for (const [key, value] of Object.entries(properties)) {
    const field = jsonSchemaToZod(value, depth + 1)
    shape[key] = required.has(key) ? field : field.optional()
  }
  return z.object(shape)
}

/** Convert one JSON Schema node to a zod schema. Unrecognised shapes fall back to z.unknown(). */
export function jsonSchemaToZod(schema: unknown, depth = 0): ZodType {
  if (!isRecord(schema)) return z.unknown()
  if (depth >= MAX_SCHEMA_DEPTH) return z.unknown()

  switch (schema["type"]) {
    case "string":
      return z.string()
    case "number":
      return z.number()
    case "integer":
      return z.number().int()
    case "boolean":
      return z.boolean()
    case "null":
      return z.null()
    case "array": {
      const items = schema["items"]
      return z.array(
        items !== undefined ? jsonSchemaToZod(items, depth + 1) : z.unknown(),
      )
    }
    case "object":
      return objectSchema(schema, depth)
    default:
      // No (or an unrecognised) `type` keyword: fall back to whatever shape
      // is actually present rather than refusing the field outright.
      return isRecord(schema["properties"]) ? objectSchema(schema, depth) : z.unknown()
  }
}

/**
 * Top-level entry: an MCP `inputSchema` always describes the object of
 * arguments a tool call takes. Anything that is not an object schema (or has
 * no usable `properties`) falls back to an open record, so a tool with an
 * unconventional schema is still callable with arbitrary arguments.
 */
export function inputSchemaToZod(inputSchema: unknown): ZodType<Record<string, unknown>> {
  if (!isRecord(inputSchema) || !isRecord(inputSchema["properties"])) {
    return z.record(z.string(), z.unknown())
  }
  return objectSchema(inputSchema, 0) as ZodType<Record<string, unknown>>
}
