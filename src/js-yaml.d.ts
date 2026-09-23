declare module 'js-yaml' {
  export function load(input: string): unknown
  export function dump(value: unknown, options?: { lineWidth?: number; [key: string]: unknown }): string
  const yaml: { load: typeof load; dump: typeof dump }
  export default yaml
}
