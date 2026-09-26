import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				// Las pruebas usan R2 simulado: el bucket real ("remote": true en
				// wrangler.jsonc) exige sesión de Cloudflare y en CI no la hay.
				remoteBindings: false,
			},
		},
	},
});
