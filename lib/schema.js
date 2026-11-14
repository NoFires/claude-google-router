const STRIP_KEYS = new Set([
  '$schema',
  '$id',
  '$anchor',
  '$defs',
  'definitions',
  '$comment',
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'patternProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'default',
  'examples',
  'readOnly',
  'writeOnly',
  'deprecated',
  'contentMediaType',
  'contentEncoding',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'dependencies',
  'minContains',
  'maxContains',
  'contains',
  'allOf',
  'not',
])

const TYPE_MAP = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

function resolveLocalRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined
  const segments = ref
    .slice(2)
    .split('/')
    .map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  let cur = root
  for (const seg of segments) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur && typeof cur === 'object' ? cur : undefined
}

function isNullSchema(node) {
  return Boolean(node && typeof node === 'object' && node.type === 'null')
}

export function sanitizeGeminiSchema(schema, root = schema, seenRefs = new Set()) {
  if (schema === true || schema === false || schema == null || typeof schema !== 'object') {
    return { type: 'object' }
  }
  if (Array.isArray(schema)) {
    return { type: 'object' }
  }

  let current = schema
  if (typeof current.$ref === 'string') {
    if (seenRefs.has(current.$ref)) {
      return { type: 'object', description: current.description }
    }
    const target = resolveLocalRef(current.$ref, root)
    if (target) {
      const nextSeen = new Set(seenRefs)
      nextSeen.add(current.$ref)
      const { $ref: _ignored, ...rest } = current
      current = { ...target, ...rest }
      return sanitizeGeminiSchema(current, root, nextSeen)
    }
  }

  const out = {}

  if ('const' in current) {
    const c = current.const
    if (c === null) {
      return { type: 'string', nullable: true }
    }
    if (typeof c === 'string') {
      out.type = 'string'
      out.enum = [c]
    } else if (typeof c === 'number') {
      out.type = Number.isInteger(c) ? 'integer' : 'number'
    } else if (typeof c === 'boolean') {
      out.type = 'boolean'
    } else {
      out.type = 'string'
    }
  }

  if (Array.isArray(current.type)) {
    const nonNull = current.type.filter(t => t !== 'null')
    if (nonNull.length !== current.type.length) out.nullable = true
    if (nonNull.length === 1 && TYPE_MAP.has(nonNull[0])) {
      out.type = nonNull[0]
    } else if (nonNull.length > 1) {
      out.anyOf = nonNull.filter(t => TYPE_MAP.has(t)).map(t => ({ type: t }))
    }
  } else if (typeof current.type === 'string' && current.type !== 'null') {
    if (TYPE_MAP.has(current.type)) {
      out.type = current.type
    }
  }

  const unionList = Array.isArray(current.oneOf)
    ? current.oneOf
    : Array.isArray(current.anyOf)
      ? current.anyOf
      : null

  if (unionList) {
    const nonNull = unionList.filter(branch => !isNullSchema(branch))
    const hadNull = nonNull.length !== unionList.length
    if (nonNull.length === 1) {
      const merged = sanitizeGeminiSchema(nonNull[0], root, seenRefs)
      Object.assign(out, merged)
      if (hadNull) out.nullable = true
    } else if (nonNull.length > 1) {
      out.anyOf = nonNull.map(branch => sanitizeGeminiSchema(branch, root, seenRefs))
      if (hadNull) out.nullable = true
    }
  }

  for (const [key, value] of Object.entries(current)) {
    if (STRIP_KEYS.has(key)) continue
    if (key === '$ref' || key === 'const' || key === 'type' || key === 'oneOf' || key === 'anyOf') continue

    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props = {}
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = sanitizeGeminiSchema(propSchema, root, seenRefs)
      }
      out.properties = props
      continue
    }

    if (key === 'items') {
      if (Array.isArray(value)) {
        out.items = value.length > 0 ? sanitizeGeminiSchema(value[0], root, seenRefs) : { type: 'string' }
      } else if (value && typeof value === 'object') {
        out.items = sanitizeGeminiSchema(value, root, seenRefs)
      }
      continue
    }

    if (key === 'enum' && Array.isArray(value)) {
      const strings = value.filter(v => v !== null && v !== undefined).map(v => String(v))
      if (strings.length > 0) out.enum = strings
      if (value.some(v => v === null)) out.nullable = true
      continue
    }

    if (key === 'required' && Array.isArray(value)) {
      out.required = value.filter(v => typeof v === 'string')
      continue
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }

  if (Array.isArray(out.required)) {
    if (out.properties && typeof out.properties === 'object') {
      out.required = out.required.filter(req => Object.prototype.hasOwnProperty.call(out.properties, req))
    } else {
      delete out.required
    }
    if (Array.isArray(out.required) && out.required.length === 0) {
      delete out.required
    }
  }

  if (!out.type && !out.anyOf) {
    if (out.properties) out.type = 'object'
    else if (out.items) out.type = 'array'
    else if (out.enum) out.type = 'string'
    else out.type = 'object'
  }

  if (out.type === 'array' && !out.items) {
    out.items = { type: 'string' }
  }

  return out
}
