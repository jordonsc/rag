import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nProvider, useT } from '../i18n';

describe('i18n', () => {
  it('resolves a catalogue key without a provider (en-GB default)', () => {
    const { result } = renderHook(() => useT());
    expect(result.current('table.empty')).toBe('No entries');
    expect(result.current('action.cancel')).toBe('Cancel');
  });

  it('interpolates {param} placeholders', () => {
    const { result } = renderHook(() => useT());
    expect(result.current('chiplist.remove', { value: 'retrieval' })).toBe('Remove retrieval');
    expect(result.current('table.sortBy', { column: 'Name' })).toBe('Sort by Name');
  });

  it('leaves unknown placeholders intact', () => {
    const { result } = renderHook(() => useT());
    expect(result.current('chiplist.remove', { other: 'x' })).toBe('Remove {value}');
  });

  it('falls back to the key itself for a missing key', () => {
    const { result } = renderHook(() => useT());
    expect(result.current('no.such.key')).toBe('no.such.key');
  });

  it('interpolates numeric params', () => {
    const { result } = renderHook(() => useT());
    expect(result.current('chiplist.remove', { value: 42 })).toBe('Remove 42');
  });

  it('honours provider message overrides', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <I18nProvider messages={{ 'table.empty': 'Nothing recorded' }}>{children}</I18nProvider>
    );
    const { result } = renderHook(() => useT(), { wrapper });
    expect(result.current('table.empty')).toBe('Nothing recorded');
    // Non-overridden keys still resolve from en-GB.
    expect(result.current('action.cancel')).toBe('Cancel');
  });
});
