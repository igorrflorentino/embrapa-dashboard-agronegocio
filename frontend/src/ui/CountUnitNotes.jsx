// CountUnitNotes — what a count reading must say out loud (see countUnits.js).
//
// Two notes, both built on CollapsingNameList so a long basket collapses instead of
// becoming a wall of names:
//   CountRefusedNote  — a total whose products count different things: no screen draws it,
//                       and this names the products and what each one counts.
//   CountLeftOutNote  — a reading that draws ONE count (the herd, say) while the basket
//                       holds another (eggs): the other is named, never dropped in silence.

import './CollapsingNameList.jsx';
import './countUnits.js';

// Names as the screen shows them: labelProductRows adds the PEVS half when two products
// share a name. Absent (a harness without filtersSchema), the bare name still beats nothing.
const nomesDe = (products, database) => {
  const rows = window.labelProductRows ? window.labelProductRows(products, database) : products;
  return rows.map((p) => p.name || p.code).sort((a, b) => a.localeCompare(b, 'pt-BR'));
};

function CountRefusedNote({ groups, database, marginTop }) {
  const refused = (groups || []).filter((g) => g.mixed);
  if (!refused.length) return null;
  const itens = refused.flatMap((g) => g.products.map((p) => {
    const noun = window.countNounOf(p);
    const what = noun ? window.COUNT_NOUNS[noun].plural : 'unidade não identificada';
    return { ...p, name: `${p.name || p.code} (${what})` };
  }));
  const plurals = [...new Set(refused.flatMap((g) => g.plurals))];
  return (
    <window.CollapsingNameList
      titulo="Contagens que não se somam"
      itens={nomesDe(itens, database)}
      substantivo="produtos"
      marginTop={marginTop}
      regra={(
        <>
          Elas contam coisas diferentes ({plurals.join(', ')}): um total delas não teria
          unidade, e o painel não o mostra. Para ver essas quantidades, selecione produtos
          que contem a mesma coisa.
        </>
      )}
    />
  );
}

function CountLeftOutNote({ groups, shown, database, onde, marginTop }) {
  if (!shown) return null;
  const others = (groups || []).filter((g) => g.id !== shown.id && !g.mixed);
  if (!others.length) return null;
  const what = others.map((g) => g.plural).join(' e ');
  return (
    <window.CollapsingNameList
      titulo="Fora desta leitura"
      itens={nomesDe(others.flatMap((g) => g.products), database)}
      substantivo="produtos"
      marginTop={marginTop}
      regra={(
        <>
          Contam {what}, não {shown.plural}, e contagens de coisas diferentes nunca são
          somadas.{onde ? <> {onde}</> : null}
        </>
      )}
    />
  );
}

Object.assign(window, { CountRefusedNote, CountLeftOutNote });
export { CountRefusedNote, CountLeftOutNote };
