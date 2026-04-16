/**
 * WiFi Chat - Service Worker
 *
 * 役割:
 *   PWA（Progressive Web App）のオフラインキャッシュ機能を担う。
 *   初回アクセス時にアプリシェル（HTML/CSS/JS/アイコン等）を
 *   Cache Storage に保存し、以降はオフライン時でもアプリが起動できるようにする。
 *
 * キャッシュ戦略:
 *   - ローカルファイル: Network First（ネットワーク優先、失敗時にキャッシュ）
 *     → 常に最新のコードが使われ、オフライン時もフォールバックで動く
 *   - 外部リソース（CDN等）: Network Only
 *     → このアプリではライブラリをローカルに持つため、外部リクエストは少ない
 *
 * ライフサイクル:
 *   install  → キャッシュ作成
 *   activate → 古いキャッシュの削除
 *   fetch    → リクエストを横断してキャッシュ戦略を適用
 */

/** キャッシュ識別名。バージョンを上げると古いキャッシュが削除される */
const CACHE_NAME = 'wifichat-v1';

/**
 * キャッシュに保存するファイルの一覧（アプリシェル）
 * これらのファイルは install 時にまとめてキャッシュされる。
 * ファイルを追加・削除した場合は CACHE_NAME のバージョンも上げること。
 */
const ASSETS = [
  './',                          // ルートパス（index.html にリダイレクト）
  './index.html',                // メインHTML
  './css/style.css',             // スタイルシート
  './js/app.js',                 // アプリケーションロジック
  './manifest.json',             // PWAマニフェスト
  './icons/icon-192.png',        // PWAアイコン（192px）
  './icons/icon-512.png',        // PWAアイコン（512px）
  './icons/icon.svg',            // SVGアイコン（ホーム画面用）
  './lib/peerjs.min.js',         // WebRTC P2P通信ライブラリ
  './lib/qrcode.min.js',         // QRコード生成ライブラリ
  './lib/html5-qrcode.min.js',   // QRコードスキャンライブラリ
];

/* =====================================================================
 * install イベント: アプリシェルをキャッシュに保存
 *
 * Service Worker の登録直後に1回だけ発火する。
 * skipWaiting() を呼ぶことで、古い SW が動いていても即座に新しい SW を有効化する。
 * ===================================================================== */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // ASSETS リストのファイルを一括でキャッシュに追加
      // いずれか1つでも失敗するとインストール全体が失敗する
      return cache.addAll(ASSETS);
    })
  );
  // 既存の古い Service Worker を待たずに即座にアクティブ化
  self.skipWaiting();
});

/* =====================================================================
 * activate イベント: 古いバージョンのキャッシュを削除
 *
 * 新しい Service Worker がアクティブになった時に発火する。
 * CACHE_NAME が変わった古いキャッシュをすべて削除してストレージを節約する。
 * clients.claim() で既存のページを即座にこの SW の管理下に置く。
 * ===================================================================== */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)  // 現在のキャッシュ以外を対象に
          .map((k) => caches.delete(k))      // すべて削除
      )
    )
  );
  // 既存のクライアント（タブ）をリロードなしでこの SW の制御下に置く
  self.clients.claim();
});

/* =====================================================================
 * fetch イベント: ネットワークリクエストを横断してキャッシュ戦略を適用
 *
 * ブラウザがネットワークリクエストを行う際に毎回発火する。
 * リクエストの種類に応じて戦略を切り替える:
 *   - GET リクエスト（自サイト）: Network First + Cache Update
 *   - GET リクエスト（外部）: Network Only（スルー）
 *   - GET 以外（POST等）: Service Worker を経由させない（スルー）
 * ===================================================================== */
self.addEventListener('fetch', (event) => {
  // GET 以外（POST, PUT など）は Service Worker を経由させない
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  // リクエスト先のホストが自サイト以外（外部CDN等）かどうか判定
  const isCDN = url.hostname !== location.hostname;

  if (isCDN) {
    // 外部リソース: Service Worker を経由せずネットワークに直接投げる
    // このアプリではライブラリをローカルに持つので、通常このブロックには入らない
    event.respondWith(fetch(event.request));
    return;
  }

  // 自サイトのリソース: Network First 戦略
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // ネットワーク取得成功 → レスポンスをキャッシュに更新保存してから返す
        const clone = response.clone(); // レスポンスは1度しか読めないので複製する
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => {
        // ネットワーク失敗（オフライン等）→ キャッシュから返す
        return caches.match(event.request);
      })
  );
});
