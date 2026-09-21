// Ambient declaration for importing extension manifests (manifest.yaml) as
// strings. Duplicated per extension repo BY DESIGN: an ambient module
// declaration must be included by each project's tsconfig, so it cannot be
// shipped inside @abc-protocol/sdk. Keep the copies identical.
declare module '*.yaml' {
  const content: string
  export default content
}
