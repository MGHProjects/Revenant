import { describe, it, expect } from 'vitest';
import { registrableDomain } from '../src/core/domain.ts';

describe('registrableDomain — unit fixtures', () => {
  // Standard two-label case
  it('returns the host unchanged when it is already two labels', () => {
    expect(registrableDomain('github.com')).toBe('github.com');
  });

  it('strips a leading subdomain from a standard TLD', () => {
    expect(registrableDomain('api.github.com')).toBe('github.com');
  });

  it('strips multiple leading subdomains from a standard TLD', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(registrableDomain('a.b.c.example.org')).toBe('example.org');
  });

  // Two-level effective TLD: co.uk
  it('returns three labels for a two-level TLD (co.uk)', () => {
    expect(registrableDomain('example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('foo.bar.co.uk')).toBe('bar.co.uk');
    expect(registrableDomain('a.b.c.bar.co.uk')).toBe('bar.co.uk');
  });

  // Two-level effective TLD: com.au
  it('handles com.au', () => {
    expect(registrableDomain('example.com.au')).toBe('example.com.au');
    expect(registrableDomain('sub.example.com.au')).toBe('example.com.au');
  });

  // Two-level effective TLD: org.uk
  it('handles org.uk', () => {
    expect(registrableDomain('example.org.uk')).toBe('example.org.uk');
    expect(registrableDomain('sub.example.org.uk')).toBe('example.org.uk');
  });

  // Two-level effective TLD: net.au
  it('handles net.au', () => {
    expect(registrableDomain('example.net.au')).toBe('example.net.au');
    expect(registrableDomain('sub.example.net.au')).toBe('example.net.au');
  });

  // Two-level effective TLD: co.nz
  it('handles co.nz', () => {
    expect(registrableDomain('example.co.nz')).toBe('example.co.nz');
    expect(registrableDomain('sub.example.co.nz')).toBe('example.co.nz');
  });

  // Two-level effective TLD: org.nz
  it('handles org.nz', () => {
    expect(registrableDomain('example.org.nz')).toBe('example.org.nz');
  });

  // Two-level effective TLD: com.br
  it('handles com.br', () => {
    expect(registrableDomain('example.com.br')).toBe('example.com.br');
    expect(registrableDomain('sub.example.com.br')).toBe('example.com.br');
  });

  // Two-level effective TLD: co.jp
  it('handles co.jp', () => {
    expect(registrableDomain('example.co.jp')).toBe('example.co.jp');
    expect(registrableDomain('sub.example.co.jp')).toBe('example.co.jp');
  });

  // Edge cases
  it('returns a single-label host unchanged', () => {
    expect(registrableDomain('localhost')).toBe('localhost');
  });

  it('is case-insensitive', () => {
    expect(registrableDomain('API.GitHub.COM')).toBe('github.com');
    expect(registrableDomain('FOO.BAR.CO.UK')).toBe('bar.co.uk');
  });

  it('strips a trailing dot (absolute hostname form)', () => {
    expect(registrableDomain('api.github.com.')).toBe('github.com');
    expect(registrableDomain('sub.example.co.uk.')).toBe('example.co.uk');
  });

  // Design doc examples verbatim
  it('matches all design-doc examples', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(registrableDomain('foo.bar.co.uk')).toBe('bar.co.uk');
    expect(registrableDomain('example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('github.com')).toBe('github.com');
    expect(registrableDomain('api.github.com')).toBe('github.com');
  });
});
