"""Ausência vs. zero — a metade Python da regra da v1.49.0.

O defeito que estas funções eliminam: **responder ZERO a uma pergunta INDEFINIDA**.
A v1.49.0 o corrigiu em 15 pontos do frontend e centralizou as primitivas em
``seriesUtils.js``; a mesma forma sobrevivia aqui no backend, em ``x if den else 0``,
alimentando métricas que o pesquisador lê:

* o **coeficiente de exportação** saía ``0%`` para uma UF sem produção — o MESMO valor
  de quem não exporta nada, e semanticamente invertido, já que quem cai nesse caso é
  justamente quem exporta sem produzir (origem não declarada, entreposto);
* a **divergência entre fontes** saía ``0%`` num ano em que NENHUMA das duas tem dado,
  que se lê como "as duas fontes concordam perfeitamente";
* **preços** e **markup** saíam ``0`` em vez de "sem preço".

Zero é uma AFIRMAÇÃO. Quando o denominador não existe, a resposta honesta é ``None`` —
que vira ``null`` no JSON e ``'—'`` na tela, porque ``numBR``/``pctBR`` já sabem
renderizar ausência. Este módulo é o único lugar onde essa distinção mora do lado
Python; nenhum call site deve reimplementar a guarda.

Ver ``frontend/src/ui/seriesUtils.js`` (as mesmas primitivas em JS) e
``tests/test_absence_guard.py`` (a varredura que impede a próxima reincidência).
"""

from __future__ import annotations

import math
from collections.abc import Iterable


def _finite(value) -> float | None:
    """O número, ou ``None`` quando não há número utilizável (None/NaN/não-numérico)."""
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def ratio_present(numerator, denominator) -> float | None:
    """``numerator / denominator``, ou ``None`` quando a razão é indefinida.

    Indefinida = qualquer extremo ausente, ou denominador não-positivo. Um denominador
    ZERO não é "razão zero": é pergunta sem resposta.
    """
    num, den = _finite(numerator), _finite(denominator)
    if num is None or den is None or den <= 0:
        return None
    return num / den


def pct_present(numerator, denominator) -> float | None:
    """:func:`ratio_present` em PONTOS PERCENTUAIS (já multiplicado por 100)."""
    r = ratio_present(numerator, denominator)
    return None if r is None else r * 100.0


def mean_present(values: Iterable) -> float | None:
    """Média dos valores PRESENTES, ou ``None`` quando não há nenhum.

    Um ausente não entra nem no numerador nem no denominador — contá-lo como zero
    puxaria a média para baixo com observações que ninguém fez. Média de nada é
    "sem média", não "média zero".
    """
    presentes = [f for f in (_finite(v) for v in values) if f is not None]
    if not presentes:
        return None
    return sum(presentes) / len(presentes)
