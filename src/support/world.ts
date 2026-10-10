import { World } from '@cucumber/cucumber'
import type { IWorldOptions } from '@cucumber/cucumber'
import type { Page, Browser, BrowserContext } from '@playwright/test'
import type { FrameworkConfig, CallRecord, OperationMap, UIStateSnapshot } from '../types'
import type { WireMockClient } from '../clients/wiremock-client'
import type { DbClient } from '../clients/db-client'
import type { RedisClient, PubSubSubscription } from '../clients/redis-client'
import type { BasePage } from '../pages/base.page'

/**
 * Base Cucumber World for component tests. Consumers can extend this
 * or use it directly. Tracks auth state, API call counts, and UI snapshots.
 */
export class ComponentTestWorld extends World {
  // --- Configuration ---
  config!: FrameworkConfig
  operationMap: OperationMap = {}

  // --- Shared clients (initialised by hooks) ---
  wiremock!: WireMockClient
  db?: DbClient
  redis?: RedisClient

  // --- Auth state ---
  accessToken: string | null = null
  refreshToken: string | null = null

  // --- Last API response ---
  lastResponse: {
    status: number
    body: unknown
    headers: Record<string, string>
  } | null = null

  // --- Valkey / Redis assertion state ---
  lastRedisValue?: string
  lastRedisMessage?: string
  activeSubscription?: PubSubSubscription

  // --- Call tracking ---
  callCounts: Map<string, number> = new Map()
  callHistory: CallRecord[] = []

  // --- UI state (Playwright) ---
  browser: Browser | null = null
  browserContext: BrowserContext | null = null
  page: Page | null = null
  pageRegistry: Map<string, BasePage> = new Map()
  uiStateSnapshots: UIStateSnapshot[] = []

  constructor(options: IWorldOptions) {
    super(options)
  }

  /**
   * Record a service call for count tracking and history, and make it the
   * last response. Pass the response headers through: anything omitted is
   * recorded as no headers, and header assertions read from here.
   */
  trackCall(
    service: string,
    requestFile: string,
    response: { status: number; body: unknown; headers?: Record<string, string> },
  ): void {
    const key = `${service}:${requestFile}`
    this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1)
    this.callHistory.push({
      service,
      requestFile,
      response,
      timestamp: new Date(),
    })
    this.lastResponse = {
      status: response.status,
      body: response.body,
      headers: response.headers ?? {},
    }
  }

  /** Get the number of times a specific service+request combination was called. */
  getCallCount(service: string, requestFile: string): number {
    return this.callCounts.get(`${service}:${requestFile}`) ?? 0
  }

  /** Save a UI element value snapshot for later assertion. */
  saveUIValue(step: string, testId: string, value: string): void {
    const existing = this.uiStateSnapshots.find((s) => s.step === step)
    if (existing) {
      existing.values[testId] = value
    } else {
      this.uiStateSnapshots.push({ step, values: { [testId]: value } })
    }
  }

  /** Get the most recently saved value for a given testId. */
  getSavedValue(testId: string): string | undefined {
    for (let i = this.uiStateSnapshots.length - 1; i >= 0; i--) {
      const val = this.uiStateSnapshots[i].values[testId]
      if (val !== undefined) return val
    }
    return undefined
  }

  /** Reset all per-scenario state. Called by Before hook. */
  resetScenario(): void {
    this.accessToken = null
    this.refreshToken = null
    this.lastResponse = null
    this.lastRedisValue = undefined
    this.lastRedisMessage = undefined
    this.activeSubscription = undefined
    this.callCounts.clear()
    this.callHistory = []
    this.uiStateSnapshots = []
  }
}
