// MetricConventions.test.js — server-native value scaling (no client-side FX).
//
// The scientific core: currency × correction select the REAL deflated value column
// SERVER-side (val_*_brl / val_*_usd / val_*_eur, real BCB PTAX), so a live banco's
// snapshot ARRIVES in the requested display currency for EVERY source — production
// (PEVS/PAM, BRL-native) AND trade (COMEX/Comtrade, US$-native customs). There is no
// client-side conversion of real data: both convFactor and convFactorFor are 1, and
// CURRENCY_FX is a symbol-only label table with NO numeric FX rate. These tests pin
// that there is no mock-FX cross-conversion path left — the regression these files
// used to encode (USD trade values multiplied by a frozen 1/0.205 rate to fake R$).
//
// Importing the ui module for side effects installs window.convFactor/
// convFactorFor/CURRENCY_FX under jsdom (the module only assigns on window).

import { describe, expect, it } from 'vitest';

import './MetricConventions.jsx';

describe('CURRENCY_FX is a symbol-only table (no fake FX rate)', () => {
  it('carries display symbols for every offered currency', () => {
    expect(window.CURRENCY_FX.BRL.symbol).toBe('R$');
    expect(window.CURRENCY_FX.USD.symbol).toBe('US$');
    expect(window.CURRENCY_FX.EUR.symbol).toBe('€');
  });

  it('carries NO numeric FX rate (the mock 0.205/0.187 path is gone)', () => {
    for (const ccy of ['BRL', 'USD', 'EUR']) {
      // A fake rate is exactly the wrong-number path this fix removed — assert it
      // does not exist, so a future edit cannot quietly reintroduce mock FX.
      expect(window.CURRENCY_FX[ccy].rate).toBeUndefined();
    }
  });
});

describe('convFactor / convFactorFor never convert server-backed values', () => {
  // The snapshot value already arrives in the requested currency for every banco,
  // so the display factor is ALWAYS 1 — never a mock multiplier on real data.
  it('convFactor is 1 for every server-native currency', () => {
    for (const currency of ['BRL', 'USD', 'EUR']) {
      expect(window.convFactor({ currency })).toBe(1);
    }
  });

  it('convFactorFor is 1 regardless of the banco base (trade is NOT cross-converted)', () => {
    // The previously-broken case: a USD-native trade banco displayed in R$/€. It used
    // to multiply by 1/0.205 (mock FX); now the BFF serves the real BRL/EUR column,
    // so the factor must be exactly 1 — no double conversion of real data.
    for (const base of ['BRL', 'USD', 'EUR', undefined, null]) {
      for (const currency of ['BRL', 'USD', 'EUR']) {
        expect(window.convFactorFor(base, { currency })).toBe(1);
      }
    }
  });

  it('a US$-native trade value is NOT rescaled when shown in R$ (no mock 1/0.205)', () => {
    // 100 (already in the requested R$ from the server) stays 100 — not ~487.8.
    const f = window.convFactorFor('USD', { currency: 'BRL' });
    expect(f).toBe(1);
    expect(100 * f).toBe(100);
  });
});

describe('clampConvention keeps every convention on the offered set', () => {
  // Since v1.88.0 an index is offered only for the currency of the economy it measures
  // (R$ → IPCA/IGP-M/IGP-DI, US$ → CPI, € → HICP). clampConvention is the shared rule the
  // strip's currency switch, the deep-link decoder and the banco-switch default reuse, so
  // no path can slip a cross pairing past the screen.
  it.each([
    ['USD', 'IGP-M', 'CPI'],
    ['USD', 'IGP-DI', 'CPI'],
    ['USD', 'IPCA', 'CPI'],
    ['EUR', 'IPCA', 'HICP'],
  ])("snaps %s × %s to the currency's own index (%s)", (currency, correction, own) => {
    const out = window.clampConvention({ currency, correction });
    expect(out.currency).toBe(currency);
    expect(out.correction).toBe(own);
  });

  it('leaves every offered combo untouched (and returns the same object reference)', () => {
    // The identity return matters: main.jsx relies on it to avoid a needless
    // conventions re-render on a no-op clamp.
    const offered = [
      { currency: 'USD', correction: 'Nominal' },
      { currency: 'USD', correction: 'CPI' },
      { currency: 'EUR', correction: 'HICP' },
      { currency: 'BRL', correction: 'IGP-M' },
      { currency: 'BRL', correction: 'IGP-DI' },
    ];
    for (const conv of offered) {
      expect(window.clampConvention(conv)).toBe(conv); // unchanged, same reference
    }
  });

  it('tolerates a null/undefined convention without throwing', () => {
    expect(window.clampConvention(null)).toBeNull();
    expect(window.clampConvention(undefined)).toBeUndefined();
  });
});

describe('scaleLabel — shared magnitude-label grammar (DEDUP-9)', () => {
  it('puts a currency SYMBOL before the magnitude suffix ("R$ bi")', () => {
    expect(window.scaleLabel('R$', 'bi')).toBe('R$ bi');
    expect(window.scaleLabel('US$', 'mi')).toBe('US$ mi');
    expect(window.scaleLabel('€', 'mil')).toBe('€ mil');
  });

  it('puts a PHYSICAL unit after the magnitude suffix ("bi t")', () => {
    expect(window.scaleLabel('t', 'bi')).toBe('bi t');
    expect(window.scaleLabel('m³', 'mi')).toBe('mi m³');
  });

  it('trims to the bare suffix when the physical unit is empty', () => {
    expect(window.scaleLabel('', 'bi')).toBe('bi');
  });

  it('drives all three scalers off ONE symbol list (so they cannot drift)', () => {
    // scaleSeries, ValueVolume _scaleStack and Geography heatScaled all call scaleLabel,
    // so changing window.SCALE_CURRENCY_SYMS changes the grammar in lockstep.
    expect(window.SCALE_CURRENCY_SYMS).toContain('R$');
    expect(window.SCALE_CURRENCY_SYMS).toContain('US$');
    expect(window.SCALE_CURRENCY_SYMS).toContain('€');
  });
});
