import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  return (
    <main className="app-shell">
      <section className="viewer-panel">
        <div className="viewer-card">
          <p className="eyebrow">Oshida Smartphone CAD</p>
          <h1>オシダスマホキャド</h1>
          <p>React + Vite + GitHub Pages の動作確認ページです。</p>
        </div>
      </section>

      <section className="control-panel">
        <h2>第一段階プロトタイプ</h2>
        <p>ここに図形追加、座標入力、ブール演算のUIを育てていきます。</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
