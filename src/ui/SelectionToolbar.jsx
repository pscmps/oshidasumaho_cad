import React from 'react';
import { GROUPS } from '../cad-core/selectors.js';
import { GROUP_COLORS, GROUP_LABELS, ENTITY_LABELS } from './NativeViewer.jsx';

export default function SelectionToolbar({ workspace: w }) {
  const count = w.groups[w.group].length;
  return <section className="selection-toolbar" aria-label="変更する場所を選ぶ">
    <div className="selection-groups" role="group" aria-label="選択する色">
      {GROUPS.map(g => <button type="button" key={g} aria-label={`${GROUP_LABELS[g]}の対象（${w.groups[g].length}件）`}
        className={w.group === g ? 'active-toggle' : ''} aria-pressed={w.group === g}
        style={{ '--group-color': GROUP_COLORS[g] }} onClick={() => w.setGroup(g)}>
        <span className="group-dot" />{GROUP_LABELS[g]}<span className="selection-count">{w.groups[g].length}</span>
      </button>)}
      <button type="button" className="clear-selection" onClick={w.clearGroup} disabled={!count}>解除</button>
    </div>
    <div className="selection-modes" role="group" aria-label="何を選ぶか">
      {['face', 'edge', 'body'].map(m => <button key={m} type="button" aria-pressed={w.mode === m} className={w.mode === m ? 'active-toggle' : ''} onClick={() => w.setMode(m)}>{ENTITY_LABELS[m]}</button>)}
      <button type="button" className={`paint-toggle ${w.paint ? 'active-toggle' : ''}`} aria-pressed={w.paint} onClick={() => w.setPaint(!w.paint)}>なぞって選ぶ</button>
    </div>
    <p className="selection-guidance" aria-live="polite">{count ? `${GROUP_LABELS[w.group]}に${count}か所選択中。下の欄で変更を伝えてください。` : `モデルの${ENTITY_LABELS[w.mode]}をタップして、${GROUP_LABELS[w.group]}で選んでください。`}</p>
  </section>;
}
