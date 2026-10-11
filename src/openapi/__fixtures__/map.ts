import type { OperationMap } from '@bearingsoftware/component-test-framework/core'

// A suite's map: comments, wrapped entries, quoted keys.
export const operationMap = {
  listOrders: { method: 'GET', path: '/api/v1/orders' },
  /** Wrapped by a formatter. */
  createOrder: {
    method: 'post',
    path: '/api/v1/orders',
  },
  // Concrete value and a query string, for one test case.
  getOrder: { method: 'GET', path: '/api/v1/orders/o-123?expand=lines' },
  listMyOrders: { method: 'GET', path: `/api/v1/orders/mine` },
} as const satisfies OperationMap
