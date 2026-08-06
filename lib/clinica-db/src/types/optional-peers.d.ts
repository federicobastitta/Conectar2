/**
 * Declaraciones ambientales para peer dependencies opcionales.
 * Estos módulos NO están instalados en este paquete — se resuelven
 * en tiempo de ejecución en el servicio que los use.
 *
 * @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, exceljs
 *   son peerDependenciesMeta: { optional: true } en package.json.
 *   El servicio que los use (api-server) los instala directamente.
 *
 * `declare module` le dice a TypeScript que el módulo existe;
 * los tipos son `any` para no requerir los @types/* de las deps opcionales.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module "exceljs" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExcelJS: any;
  export default ExcelJS;
  export = ExcelJS;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module "@aws-sdk/client-s3" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const S3Client: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const GetObjectCommand: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const PutObjectCommand: any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module "@aws-sdk/s3-request-presigner" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const getSignedUrl: any;
}
