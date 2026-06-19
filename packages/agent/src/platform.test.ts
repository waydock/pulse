import { describe, it, expect } from 'vitest'
import { isSupportedPlatform, SUPPORTED_PLATFORMS, UNSUPPORTED_MESSAGE } from './platform.js'

describe('isSupportedPlatform', () => {
  it('supports macOS and Linux', () => {
    expect(isSupportedPlatform('darwin')).toBe(true)
    expect(isSupportedPlatform('linux')).toBe(true)
  })
  it('does not support Windows (yet)', () => {
    expect(isSupportedPlatform('win32')).toBe(false)
  })
  it('exposes the supported set and a clear message', () => {
    expect(SUPPORTED_PLATFORMS).toEqual(['darwin', 'linux'])
    expect(UNSUPPORTED_MESSAGE).toMatch(/macOS and Linux/)
    expect(UNSUPPORTED_MESSAGE).toMatch(/Windows/)
  })
})
