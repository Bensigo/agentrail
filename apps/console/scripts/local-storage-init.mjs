import { S3Client, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
const client = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY } });
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    try { await client.send(new HeadBucketCommand({ Bucket: "agentrail-artifacts" }), { abortSignal: AbortSignal.timeout(3000) }); }
    catch (error) {
      if (error.$metadata?.httpStatusCode !== 404) throw error;
      await client.send(new CreateBucketCommand({ Bucket: "agentrail-artifacts" }), { abortSignal: AbortSignal.timeout(3000) });
    }
    console.log("Local artifact bucket ready."); process.exit(0);
  } catch { if (attempt === 29) { console.error("Local artifact store did not become ready."); process.exit(1); } }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
