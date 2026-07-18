import { safeAccountPoolSnapshot } from '../../src/routing/standalone-route-adapter.js'

describe('safe account-pool projection', () => {
	it('normalizes quota, health, runtime and route decisions without secrets', () => {
		const snapshot = safeAccountPoolSnapshot({
			chatgptAccountStrategy: 'weighted',
			chatgptLowQuotaThreshold: 22,
			chatgptAccounts: [{
				id: 'cred_a',
				label: '   ',
				account_id: 'short-id',
				status: 'cooldown',
				routing_enabled: false,
				routing_weight: 250,
				low_quota_threshold: 'invalid',
				daily_request_limit: -5,
				daily_token_limit: 12.8,
				reserved_models: 'not-an-array',
				usage: {
					primary: {
						used_percent: 25,
						resets_at: 'invalid',
						window_minutes: 300
					},
					secondary: {
						remaining_percent: 20,
						resets_at: 1_800_000_000,
						window_minutes: 10_080
					}
				},
				usage_updated_at: '',
				usage_sync_status: '',
				usage_sync_error: 'temporary quota error',
				access_token: 'must-never-be-returned'
			}]
		}, [{
			id: 'cred_a',
			status: 'auth_error',
			active_requests: 'invalid',
			concurrency_limit: 2,
			cooldown_until: '',
			model_cooldowns: -1
		}], {
			accounts: {
				cred_a: {
					requests: 4,
					success_rate: 'invalid',
					p95_latency_ms: 950,
					rate_limited: 2,
					last_request_at: '2026-07-18T10:00:00.000Z',
					last_error_type: 'rate_limit',
					last_error_message: 'safe diagnostic'
				}
			}
		}, { depth: -4 }, [{
			at: '2026-07-18T10:00:00.000Z',
			model: 'gpt-5.4',
			selected_account_id: 'cred_a',
			selected_account_label: 'Account A',
			outcome: 'selected',
			queue_wait_ms: 12,
			accounts: [{
				id: 'cred_a',
				label: 'Account A',
				result: 'selected',
				reason: 'highest headroom',
				remaining_percent: 75
			}]
		}])

		expect(snapshot).toMatchObject({
			strategy: 'weighted',
			queueDepth: 0,
			accounts: [{
				id: 'cred_a',
				label: 'ChatGPT 账号',
				accountIdPreview: 'short-id',
				status: 'auth_error',
				routingEnabled: false,
				routingWeight: 100,
				lowQuotaThreshold: 22,
				dailyRequestLimit: 0,
				dailyTokenLimit: 12,
				reservedModels: [],
				quota: {
					primary: {
						usedPercent: 25,
						remainingPercent: 75,
						resetsAt: null,
						windowMinutes: 300
					},
					secondary: {
						usedPercent: null,
						remainingPercent: 20,
						resetsAt: 1_800_000_000
					},
					syncStatus: 'pending',
					syncError: 'temporary quota error'
				},
				runtime: {
					activeRequests: 0,
					concurrencyLimit: 2,
					cooldownUntil: null,
					modelCooldowns: 0
				},
				health: {
					requests: 4,
					successRate: null,
					p95LatencyMs: 950,
					rateLimited: 2,
					lastErrorMessage: 'safe diagnostic'
				}
			}],
			recentRouteDecisions: [{
				selectedAccountId: 'cred_a',
				selectedAccountLabel: 'Account A',
				queueWaitMs: 12,
				accounts: [{
					id: 'cred_a',
					remainingPercent: 75
				}]
			}]
		})
		expect(JSON.stringify(snapshot)).not.toContain('must-never-be-returned')
	})

	it('returns an empty safe default for malformed runtime inputs', () => {
		expect(safeAccountPoolSnapshot({}, null, null, null, null)).toEqual({
			strategy: 'headroom',
			accounts: [],
			queueDepth: 0,
			recentRouteDecisions: []
		})
	})
})
