/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

interface Env {
	CLOUDFLARE_ACCOUNT_ID: string;
	R2_BUCKET_NAME: string;
	CLOUDFLARE_R2_ACCESS_KEY_ID: string;
	CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
	BlogAssets: KVNamespace,
}

interface CachedSignedUrl {
	url: string;
	refreshTime: number;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const s3Client = new S3Client({
			region: 'auto',
			endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
			credentials: {
				accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
				secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
			},
		});
		const url = new URL(request.url);

		if (!url.pathname.startsWith('/cdn/')) {
			// Pass through to origin for all other requests
			const response = await fetch(request);
			return new Response(response.body as BodyInit, {
				status: response.status,
				headers: response.headers,
			});
		}

		const key = url.pathname.slice(5);
		console.log('Key:', key);

		try {
			let cache = await env.BlogAssets.get<CachedSignedUrl>(key, `json`);
			let signedUrl: string;
			if (!cache || Date.now() > cache.refreshTime) {
				const command = new GetObjectCommand({
					Bucket: env.R2_BUCKET_NAME,
					Key: key,
				});
				signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
				await env.BlogAssets.put(key, JSON.stringify({
					url: signedUrl,
					refreshTime: Date.now() + 55 * 60 * 1000,
				}), { expirationTtl: 3600 });
			} else {
				signedUrl = cache.url;
			}
			const response = await fetch(signedUrl);
			return new Response(response.body as BodyInit, {
				status: response.status,
				headers: response.headers,
			});
		} catch (error) {
			console.error('Error generating signed URL:', error);
			return new Response('Failed to generate signed URL', { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;