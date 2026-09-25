/**
 * The slice of `js-yaml` this plugin uses.
 *
 * Enough for `load`/`dump`, plus the `Type`/`DEFAULT_SCHEMA` pair the profile
 * patch needs: a patch may carry the loader's `!!js` tag, which the default
 * schema rejects (see `JS_EXPRESSION_TAG` in `preset-rows.ts`).
 */
declare module 'js-yaml' {
  export type NodeKind = 'scalar' | 'sequence' | 'mapping'

  export interface TypeDefinition {
    kind: NodeKind
    resolve?: (data: unknown) => boolean
    construct?: (data: unknown) => unknown
  }

  export class Type {
    constructor(tag: string, definition: TypeDefinition)
  }

  export interface Schema {
    extend(types: Type[]): Schema
  }

  export const DEFAULT_SCHEMA: Schema

  export function load(input: string, options?: { schema?: Schema }): unknown

  export function dump(value: unknown, options?: { lineWidth?: number; [key: string]: unknown }): string

  const yaml: {
    load: typeof load
    dump: typeof dump
    Type: typeof Type
    DEFAULT_SCHEMA: Schema
  }
  export default yaml
}
