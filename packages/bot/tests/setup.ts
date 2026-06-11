// Test setup file
// Configura mocks globales para GRVT API y database

import { vi, beforeAll, afterEach } from 'vitest';

// Env vars must be set at module level, NOT inside beforeAll: client.ts
// instantiates GRVTClient at import time and throws if they're missing,
// and beforeAll only runs after the test file's imports resolve. Module
// level in a setup file runs before any test file is imported. Without
// these, the suite only passes when a populated .env happens to exist.
// (match names used by order-signer.ts fallback path)
process.env.GRVT_API_SECRET = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
process.env.GRVT_TRADING_ADDRESS = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
process.env.GRVT_TRADING_ACCOUNT_ID = '1';
// signToken() throws if JWT_SECRET is missing or < 32 chars — without it
// every signup/login test that issues a token dies with a 500.
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789abcdef';

// Mock de GRVT Client
export const mockGrvtClient = {
  getOpenOrders: vi.fn(),
  getFillHistory: vi.fn(),
  getAccountSummary: vi.fn(),
  createOrder: vi.fn(),
  cancelOrder: vi.fn(),
  cancelAllOrders: vi.fn(),
  getInstruments: vi.fn(),
  auth: {
    login: vi.fn(),
    logout: vi.fn()
  }
};

// Mock de Database
export const mockDb = {
  getBot: vi.fn(),
  createBot: vi.fn(),
  updateBot: vi.fn(),
  getGridLevels: vi.fn(),
  createGridLevel: vi.fn(),
  updateGridLevel: vi.fn(),
  fillGridLevel: vi.fn(),
  createOrder: vi.fn(),
  updateOrderStatus: vi.fn(),
  createTrade: vi.fn(),
  getOrders: vi.fn(),
  close: vi.fn()
};

// Mock Console para evitar spam en tests
const mockConsole = {
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn()
};

beforeAll(() => {
  // Replace console
  global.console = mockConsole as any;
});

afterEach(() => {
  // Reset all mocks after each test
  vi.clearAllMocks();
});

// Utility functions for tests
export function createMockFill(data: Partial<any> = {}): any {
  return {
    fill_id: `fill_${Date.now()}`,
    order_id: 'order_123',
    client_order_id: 'client_123',
    price: '2000.0',
    size: '0.02',
    fee: '0.1',
    fee_currency: 'USDT',
    is_buyer: true,
    event_time: Date.now().toString(),
    created_time: Date.now() / 1000,
    timestamp: new Date().toISOString(),
    ...data
  };
}

export function createMockOrder(data: Partial<any> = {}): any {
  return {
    id: 'order_123',
    order_id: 'order_123',
    bot_id: 1,
    grid_level_id: 1,
    side: 'buy',
    quantity: 0.02,
    price: 2000.0,
    status: 'active',
    metadata: 'client_123',
    ...data
  };
}

export function createMockGridLevel(data: Partial<any> = {}): any {
  return {
    id: 1,
    bot_id: 1,
    level_index: 10,
    price: 2000.0,
    side: 'buy',
    quantity: 0.02,
    is_filled: false,
    order_id: null,
    ...data
  };
}