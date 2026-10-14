# template.yaml, line by line

```yaml
AWSTemplateFormatVersion: '2010-09-09'
```
The CloudFormation template format version. It is the only valid value; it is not a date you change.

```yaml
Transform: AWS::Serverless-2016-10-31
```
This line makes it a **SAM** template. At deploy time CloudFormation runs the SAM macro, which expands short `AWS::Serverless::*` resources into plain CloudFormation (Lambda function, IAM role, API Gateway API, stage, route, integration, permission).

```yaml
Description: mini-ofc - mini order fulfilment backend
```
Free text shown on the stack in the CloudFormation console.

```yaml
Globals:
  Function:
```
Defaults applied to every `AWS::Serverless::Function`, so each new Lambda (orders, consumer, etc.) does not repeat them. A function can still override any value.

```yaml
    Runtime: nodejs22.x
```
The managed Node.js 22 runtime. AWS patches it; you only ship your bundled JS.

```yaml
    Architectures:
      - arm64
```
Run on Graviton (ARM). Roughly 20% cheaper per GB-second than x86 and usually as fast or faster. The trade-off: native npm modules must have ARM builds. We have none.

```yaml
    Timeout: 10
```
Max seconds one invocation may run before Lambda kills it. HTTP API itself gives up after 30 s, so the Lambda timeout should stay below that. 10 s is generous for a DynamoDB read.

```yaml
    MemorySize: 256
```
MB of memory. CPU is allocated in proportion to memory, so this also sets CPU. 256 MB is a cheap, sensible start; tune later with real latency data.

```yaml
Resources:
```
Everything AWS will create. Each key below is a **logical ID** you reference elsewhere in the template.

```yaml
  HttpApi:
    Type: AWS::Serverless::HttpApi
```
An API Gateway **HTTP API** (v2). Declaring it explicitly (instead of letting SAM create an implicit one) gives a logical ID we can `!Ref` in outputs and, later, attach CORS, auth or more routes to. It gets a `$default` stage with auto-deploy.

```yaml
  ProductsFunction:
    Type: AWS::Serverless::Function
```
One Lambda function. SAM also creates its IAM execution role (with CloudWatch Logs permission) and a log group on first invocation.

```yaml
    Properties:
      Handler: getProducts.handler
```
`<file>.<export>` inside the built artifact. esbuild outputs `getProducts.js` exporting `handler`, so Lambda calls `getProducts.handler`.

```yaml
      Events:
        GetProducts:
          Type: HttpApi
```
What triggers the function. `GetProducts` is just a name. `Type: HttpApi` means an HTTP API route, and SAM adds the Lambda permission so API Gateway may invoke it.

```yaml
          Properties:
            ApiId: !Ref HttpApi
            Path: /products
            Method: GET
```
Attach the route `GET /products` to *our* `HttpApi` (`!Ref` returns its API ID). Uses payload format 2.0, which is why the handler is typed `APIGatewayProxyHandlerV2`.

```yaml
    Metadata:
      BuildMethod: esbuild
```
Tells `sam build` to bundle with esbuild instead of copying `node_modules`. Result: one small JS file per function, faster cold starts, and TypeScript compiled without a separate `tsc` step. esbuild must be in `devDependencies` (it is).

```yaml
      BuildProperties:
        EntryPoints:
          - src/handlers/getProducts.ts
```
The file esbuild starts from. Imports are followed and bundled in. Type-only imports (`aws-lambda` types) disappear at build time.

```yaml
        Target: es2022
```
The JavaScript language level to emit. Node 22 supports it fully, so no down-levelling.

```yaml
        Minify: true
        Sourcemap: true
```
Smaller bundle (less to load on cold start) plus a source map so stack traces in CloudWatch still point to your `.ts` lines.

```yaml
Outputs:
  HttpApiUrl:
    Description: Base URL of the HTTP API
```
Values printed at the end of `sam deploy` and visible on the stack, so you never dig through the console for the URL.

```yaml
    Value: !Sub 'https://${HttpApi}.execute-api.${AWS::Region}.${AWS::URLSuffix}'
```
`!Sub` builds a string. `${HttpApi}` resolves to the API ID, `${AWS::Region}` to e.g. `ap-southeast-2`, and `${AWS::URLSuffix}` to `amazonaws.com`. The `$default` stage has no path prefix, so `curl "$URL/products"` works directly.

## Things to say if asked
- **Why no `CodeUri`?** It defaults to the template folder, where `package.json` lives, which esbuild needs.
- **Where is the IAM role?** SAM generates a least-privilege execution role. When we add DynamoDB we'll attach a policy template such as `DynamoDBReadPolicy` instead of hand-writing IAM.
- **How do I remove everything?** `sam delete --stack-name mini-ofc` deletes the CloudFormation stack and every resource in it.
