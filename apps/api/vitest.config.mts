import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// The secrets live in .dev.vars, which is untracked -- a clone with
					// no local Supabase or R2 still has to be able to run the suite, and
					// nothing here should ever be able to reach a real project. The
					// non-secret vars keep coming from wrangler.jsonc, since
					// worker-configuration.d.ts types them as literals.
					bindings: {
						SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
						R2_ACCOUNT_ID: "test-account-id",
						R2_ACCESS_KEY_ID: "test-access-key-id",
						R2_SECRET_ACCESS_KEY: "test-secret-access-key",
					},
				},
			},
		},
	},
});
