/**
 * WiFi Chat - アプリケーションメインロジック
 *
 * 概要:
 *   同一WiFiネットワーク上のiPhone同士がP2P（ピアツーピア）で
 *   テキスト・画像チャットを行うPWAアプリのコアスクリプト。
 *
 * 通信方式:
 *   PeerJS（WebRTC DataChannel ラッパー）を使用。
 *   PeerJS のシグナリングサーバーを経由して接続を確立した後は、
 *   データは端末間を直接（P2P）流れるためサーバーへの依存がほぼない。
 *
 * 接続フロー:
 *   ①ホスト側: createPeer() でユニークなPeer IDを取得 → QRコードに埋め込む
 *   ②ゲスト側: QRコードをスキャン → Peer ID を取得 → ホストへ接続
 *   ③接続確立後: チャット画面へ遷移してメッセージ送受信開始
 *
 * QRコードスキャンの2段階方式:
 *   方式1（優先）: カメラのリアルタイムスキャン（getUserMedia）
 *   方式2（フォールバック）: ネイティブカメラで撮影 → 画像からデコード
 *   iOS PWA スタンドアロンモードでは getUserMedia が制限されるため、
 *   方式1が失敗した場合はカメラ許可の案内と方式2のボタンを自動表示する。
 *
 * 画像転送:
 *   大きな画像は Base64 エンコード後に 16KB ずつチャンク分割して送信。
 *   送信前に Canvas で最大1200pxにリサイズし通信量を削減。
 */
(function () {
  'use strict';

  // =====================================================================
  // アプリ状態管理
  // =====================================================================

  /** PeerJS の Peer インスタンス（接続していない間は null） */
  let peer = null;

  /** 相手との DataConnection インスタンス（接続していない間は null） */
  let conn = null;

  /** Html5Qrcode スキャナーインスタンス（スキャン中以外は null） */
  let qrScanner = null;

  /**
   * 画像チャンク転送の最大サイズ（バイト）
   * WebRTC DataChannel の推奨パケットサイズに合わせて 16KB に設定。
   * これより大きいと一部ブラウザで分割されてしまう場合がある。
   */
  const CHUNK_SIZE = 16000;

  // =====================================================================
  // ユーティリティ
  // =====================================================================

  /** CSS セレクタからDOM要素を取得するショートハンド */
  const $ = (sel) => document.querySelector(sel);

  /**
   * 各画面のDOMエレメントをまとめたオブジェクト
   * showScreen() で参照する
   */
  const screens = {
    home: $('#screen-home'),   // ホーム画面（アプリ起動時）
    qr:   $('#screen-qr'),    // QRコード表示画面（ホスト側）
    scan: $('#screen-scan'),   // QRコードスキャン画面（ゲスト側）
    chat: $('#screen-chat'),   // チャット画面（接続後）
  };

  // =====================================================================
  // 画面遷移
  // =====================================================================

  /**
   * 指定した画面を表示し、それ以外を非表示にする。
   * CSS クラス "active" の付け替えで切り替えを実現。
   *
   * @param {string} name - screens オブジェクトのキー名
   */
  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  // =====================================================================
  // PeerJS 初期化
  // =====================================================================

  /**
   * PeerJS の Peer インスタンスを生成し、シグナリングサーバーへの
   * 接続が完了するまで待機する非同期関数。
   *
   * Peer ID は "wifichat-" + ランダム8文字で生成。
   * ICE サーバーには Google の公開 STUN サーバーを使用。
   * （同一LAN内の場合、STUNがなくてもほとんど接続できるが、
   *   念のため設定しておく）
   *
   * @returns {Promise<Peer>} 接続済みの Peer インスタンス
   */
  function createPeer() {
    return new Promise((resolve, reject) => {
      // ユニークな Peer ID を生成（例: wifichat-ab3x9kfm）
      const id = 'wifichat-' + Math.random().toString(36).substring(2, 10);

      const p = new Peer(id, {
        config: {
          iceServers: [
            // Google の STUN サーバー（NAT越えのためのアドレス取得に使用）
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ],
        },
      });

      // PeerJS シグナリングサーバーへの接続完了時
      p.on('open', () => resolve(p));

      // エラー発生時（ネットワーク不通、IDの重複など）
      p.on('error', (err) => {
        console.error('Peer error:', err);
        reject(err);
      });
    });
  }

  // =====================================================================
  // ホスト側: QRコード表示
  // =====================================================================

  /**
   * ホスト（QRコードを見せる側）の処理を開始する。
   *
   * 処理手順:
   *   1. QR表示画面へ遷移
   *   2. Peer インスタンスを生成してシグナリングサーバーへ登録
   *   3. 取得した Peer ID を QRコードとして描画
   *   4. ゲストからの接続を待ち受ける
   */
  async function startHost() {
    showScreen('qr');
    const statusEl = $('#qr-status');
    const loaderEl = $('#qr-loader');

    try {
      // Peer インスタンスを生成（シグナリングサーバーへの登録完了まで待機）
      peer = await createPeer();
      statusEl.textContent = '接続待機中... (ID: ' + peer.id + ')';

      // ---- QRコード描画 ----------------------------------------
      const qrContainer = $('#qr-code');
      qrContainer.innerHTML = ''; // 既存のQRコードをクリア

      // QRCode.js を使って Canvas に Peer ID を QRコードとして描画
      await QRCode.toCanvas(
        qrContainer.appendChild(document.createElement('canvas')),
        peer.id,  // QRコードに埋め込む文字列 = Peer ID
        {
          width: 220,                              // QRコードのサイズ（px）
          margin: 2,                               // 余白（モジュール数）
          color: { dark: '#1a1a2e', light: '#ffffff' }, // 色設定
        }
      );

      // ---- ゲストからの接続を待ち受け -------------------------
      peer.on('connection', (incoming) => {
        // ゲストが connect() を呼び出すと、ここのイベントが発火する
        conn = incoming;
        statusEl.textContent = '接続中...';
        setupConnection(); // 共通の接続セットアップへ
      });

    } catch (err) {
      // Peer 生成失敗（ネットワーク不通など）
      statusEl.textContent = 'エラー: ' + err.message;
      loaderEl.classList.add('hidden');
    }
  }

  // =====================================================================
  // ゲスト側: QRコードスキャン
  // =====================================================================

  /**
   * ゲスト（QRコードを読み取る側）のスキャン処理を開始する。
   *
   * まずカメラのリアルタイムスキャンを試み、失敗した場合は
   * 写真撮影によるフォールバック方式に切り替える。
   *
   * iOS PWA のスタンドアロンモード（ホーム画面から起動）では
   * getUserMedia が制限されるため、フォールバック方式が重要。
   */
  async function startScan() {
    showScreen('scan');
    const statusEl = $('#scan-status');
    const fallbackEl = $('#scan-fallback');
    const readerEl = $('#qr-reader');

    // 前回の表示状態をリセット
    fallbackEl.style.display = 'none';
    readerEl.style.display = '';

    try {
      // ---- 方式1: カメラのリアルタイムスキャン ----
      // Html5Qrcode ライブラリでスキャナーを初期化
      qrScanner = new Html5Qrcode('qr-reader');

      await qrScanner.start(
        { facingMode: 'environment' }, // 背面カメラを使用（iPhoneのメインカメラ）
        {
          fps: 10,                          // スキャン頻度（毎秒10回）
          qrbox: { width: 250, height: 250 }, // 認識エリアのサイズ
        },
        // ---- QRコード読み取り成功時のコールバック ----
        async (decodedText) => {
          // スキャナーを停止してカメラを閉じる
          await qrScanner.stop();
          qrScanner = null;
          statusEl.textContent = '接続中...';

          // 読み取ったテキスト（= ホストの Peer ID）でP2P接続を開始
          await connectToPeer(decodedText);
        },
        // ---- QRコード読み取り失敗時のコールバック ----
        () => {} // 認識できないフレームは無視（毎フレーム呼ばれるため何もしない）
      );

    } catch (err) {
      // ---- 方式2: フォールバック（写真撮影からデコード） ----
      // カメラ権限が拒否された、またはiOS PWAで getUserMedia が使えない場合
      console.warn('カメラのリアルタイムスキャン不可。フォールバックを表示:', err);

      // リアルタイムスキャナーのUIを隠し、フォールバックUIを表示
      readerEl.style.display = 'none';
      fallbackEl.style.display = 'flex';
      statusEl.textContent = '';
    }
  }

  /**
   * 写真撮影フォールバック: 撮影した画像ファイルからQRコードをデコードする。
   *
   * html5-qrcode の scanFileV2() メソッドを使い、
   * ネイティブカメラで撮影した写真の中からQRコードを認識する。
   * iOS PWA でもネイティブカメラアプリの起動は許可されているため、
   * この方法なら確実にQRコードを読み取れる。
   *
   * @param {File} file - input[type=file] から取得した画像ファイル
   */
  async function scanFromFile(file) {
    const statusEl = $('#scan-status');
    statusEl.textContent = 'QRコードを解析中...';

    try {
      // Html5Qrcode インスタンスを生成（スキャン開始は不要）
      const scanner = new Html5Qrcode('qr-reader-fallback-temp');

      // 画像ファイルからQRコードをデコード
      const result = await scanner.scanFileV2(file, /* showImage= */ false);
      const decodedText = result.decodedText;

      statusEl.textContent = '接続中...';
      await connectToPeer(decodedText);
    } catch (err) {
      // QRコードが認識できなかった場合
      statusEl.textContent = 'QRコードを認識できませんでした。もう一度撮影してください。';
      console.error('QRファイルスキャンエラー:', err);
    }
  }

  /**
   * スキャンで取得した Peer ID を使ってホストへP2P接続を試みる。
   *
   * @param {string} peerId - ホスト側の Peer ID（QRコードから取得）
   */
  async function connectToPeer(peerId) {
    try {
      // 自分自身の Peer インスタンスを生成
      peer = await createPeer();

      // ホストの Peer ID に向けて接続要求を送る
      // reliable: true = 順序保証・再送あり（TCPライク）のDataChannelを使用
      conn = peer.connect(peerId, { reliable: true });

      setupConnection(); // 共通の接続セットアップへ
    } catch (err) {
      $('#scan-status').textContent = 'エラー: ' + err.message;
    }
  }

  // =====================================================================
  // 接続セットアップ（ホスト・ゲスト共通）
  // =====================================================================

  /**
   * DataConnection のイベントリスナーをセットアップする。
   * ホスト・ゲスト両方から呼び出される共通処理。
   *
   * イベント:
   *   open  - P2P接続確立完了
   *   data  - 相手からデータ受信
   *   close - 相手が接続を閉じた
   *   error - 接続エラー発生
   */
  function setupConnection() {
    // ---- 接続確立時 ------------------------------------------
    conn.on('open', () => {
      showScreen('chat'); // チャット画面へ遷移
      $('#chat-peer-name').textContent = 'チャット相手';
      $('#chat-status').textContent = '接続中';
      addSystemMessage('接続しました！'); // システムメッセージを表示
    });

    // ---- データ受信時 ----------------------------------------
    conn.on('data', (data) => {
      handleIncomingData(data);
    });

    // ---- 相手が切断した時 ------------------------------------
    conn.on('close', () => {
      $('#chat-status').textContent = '切断されました';
      $('#chat-status').style.color = '#ef4444'; // 赤色に変更
      addSystemMessage('相手が切断しました');
    });

    // ---- 接続エラー時 ----------------------------------------
    conn.on('error', (err) => {
      console.error('Connection error:', err);
      addSystemMessage('接続エラー: ' + err.message);
    });
  }

  // =====================================================================
  // 受信データの処理
  // =====================================================================

  /**
   * 受信中の画像チャンクを一時保持するオブジェクト。
   * キー: 画像転送ID、値: { chunks, received, mimeType, time }
   */
  const imageChunks = {};

  /**
   * 相手から受信したデータを種別に応じて振り分ける。
   *
   * メッセージの種別（type フィールドで判定）:
   *   "text"        - テキストメッセージ
   *   "image-start" - 画像転送の開始通知（総チャンク数などのメタ情報）
   *   "image-chunk" - 画像データの分割チャンク
   *
   * @param {string} data - 受信したJSON文字列
   */
  function handleIncomingData(data) {
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);

        if (parsed.type === 'text') {
          // ---- テキストメッセージ --------------------------------
          addMessage(parsed.content, false, parsed.time);

        } else if (parsed.type === 'image-start') {
          // ---- 画像転送開始 --------------------------------------
          // これから届くチャンクを収集するためのエントリを作成
          imageChunks[parsed.id] = {
            chunks: new Array(parsed.totalChunks), // チャンクを格納する配列（インデックス指定）
            received: 0,                            // 受信済みチャンク数
            mimeType: parsed.mimeType,              // 画像のMIMEタイプ（例: image/jpeg）
            time: parsed.time,                      // 送信時刻文字列
          };

        } else if (parsed.type === 'image-chunk') {
          // ---- 画像チャンク受信 -----------------------------------
          const img = imageChunks[parsed.id];
          if (img) {
            // 正しいインデックス位置にチャンクを格納
            img.chunks[parsed.index] = parsed.data;
            img.received++;

            // 全チャンクが揃ったら画像を表示
            if (img.received === img.chunks.length) {
              const fullData = img.chunks.join(''); // Base64文字列を結合
              addImageMessage(fullData, img.mimeType, false, img.time);
              delete imageChunks[parsed.id]; // メモリ解放
            }
          }
        }

      } catch (e) {
        // JSON のパースに失敗した場合はプレーンテキストとして扱う（フォールバック）
        addMessage(data, false);
      }
    }
  }

  // =====================================================================
  // メッセージ送信
  // =====================================================================

  /**
   * テキストメッセージを相手に送信し、自分のチャット画面にも表示する。
   *
   * 送信フォーマット（JSON）:
   *   { type: "text", content: "本文", time: "HH:MM" }
   *
   * @param {string} text - 送信するテキスト文字列
   */
  function sendTextMessage(text) {
    // 接続が確立されていない、または空文字の場合は何もしない
    if (!conn || !conn.open || !text.trim()) return;

    // 送信時刻を HH:MM 形式で生成
    const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

    const msg = JSON.stringify({ type: 'text', content: text.trim(), time: time });
    conn.send(msg); // DataChannel でデータを送信

    // 自分のUIにも即座に表示（送信済みとして右側に表示）
    addMessage(text.trim(), true, time);
  }

  /**
   * カメラロールから選択した画像ファイルを相手に送信する。
   *
   * 送信手順:
   *   1. FileReader で画像を Base64 エンコード
   *   2. 転送開始を通知する "image-start" メッセージを送信
   *   3. Base64 文字列を CHUNK_SIZE ごとに分割して "image-chunk" を送信
   *   4. 自分のUIにも送信済み画像を表示
   *
   * @param {File} file - input[type=file] から取得した画像ファイル
   */
  function sendImage(file) {
    if (!conn || !conn.open) return;

    const reader = new FileReader();

    reader.onload = () => {
      // data:image/jpeg;base64,XXXXXXX... という形式から Base64 部分のみ取り出す
      const base64 = reader.result.split(',')[1];
      const mimeType = file.type; // 例: "image/jpeg", "image/png"
      const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

      // この画像転送を識別するためのユニークID
      const id = 'img-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);

      // 何チャンクに分割するか計算
      const totalChunks = Math.ceil(base64.length / CHUNK_SIZE);

      // ---- 転送開始メッセージを送信 ----------------------------
      // 受信側はこれを受け取って配列を確保し、チャンクの受け入れ準備をする
      conn.send(JSON.stringify({
        type: 'image-start',
        id: id,                    // この転送のユニークID
        totalChunks: totalChunks,  // 全チャンク数
        mimeType: mimeType,        // MIMEタイプ
        time: time,                // 送信時刻
      }));

      // ---- Base64 をチャンク分割して順次送信 -------------------
      for (let i = 0; i < totalChunks; i++) {
        const chunk = base64.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        conn.send(JSON.stringify({
          type: 'image-chunk',
          id: id,      // どの転送に属するか
          index: i,    // 何番目のチャンクか（受信側で正しい順番に並べ直す）
          data: chunk, // Base64 チャンクデータ
        }));
      }

      // 送信した画像を自分のUI（右側）にも表示
      addImageMessage(base64, mimeType, true, time);
    };

    // ファイルを Data URL（Base64 形式）として読み込む
    reader.readAsDataURL(file);
  }

  // =====================================================================
  // UI: メッセージ描画
  // =====================================================================

  /**
   * テキストメッセージをチャット欄に追加する。
   *
   * @param {string}  text   - 表示するテキスト
   * @param {boolean} isMine - true なら自分のメッセージ（右側）、false なら相手（左側）
   * @param {string}  [time] - 時刻文字列（省略可）
   */
  function addMessage(text, isMine, time) {
    const container = $('#chat-messages');
    const el = document.createElement('div');

    // 自分のメッセージは msg-mine（右寄せ・青）、相手は msg-peer（左寄せ・白）
    el.className = 'msg ' + (isMine ? 'msg-mine' : 'msg-peer');

    // テキストはXSS対策のため textContent / createTextNode で追加
    const textNode = document.createTextNode(text);
    el.appendChild(textNode);

    if (time) {
      const timeEl = document.createElement('span');
      timeEl.className = 'msg-time';
      timeEl.textContent = time;
      el.appendChild(timeEl);
    }

    container.appendChild(el);
    // 最新メッセージが常に見えるようにスクロール
    container.scrollTop = container.scrollHeight;
  }

  /**
   * 画像メッセージをチャット欄に追加する。
   * タップするとフルスクリーンモーダルで拡大表示される。
   *
   * @param {string}  base64Data - Base64 エンコードされた画像データ
   * @param {string}  mimeType   - MIMEタイプ（例: "image/jpeg"）
   * @param {boolean} isMine     - 自分の送信かどうか
   * @param {string}  [time]     - 時刻文字列
   */
  function addImageMessage(base64Data, mimeType, isMine, time) {
    const container = $('#chat-messages');
    const el = document.createElement('div');
    el.className = 'msg msg-image ' + (isMine ? 'msg-mine' : 'msg-peer');

    const img = document.createElement('img');
    // Base64 を Data URL 形式に組み立てて src に設定
    img.src = 'data:' + mimeType + ';base64,' + base64Data;
    img.alt = '画像';
    // タップ時にモーダルで拡大表示
    img.addEventListener('click', () => {
      openImageModal(img.src);
    });
    el.appendChild(img);

    if (time) {
      const timeEl = document.createElement('span');
      timeEl.className = 'msg-time';
      timeEl.textContent = time;
      el.appendChild(timeEl);
    }

    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  /**
   * システムメッセージ（接続完了・切断通知など）をチャット欄の中央に表示する。
   *
   * @param {string} text - 表示するシステムメッセージ
   */
  function addSystemMessage(text) {
    const container = $('#chat-messages');
    const el = document.createElement('div');
    el.className = 'msg msg-system';
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  // =====================================================================
  // 画像モーダル（フルスクリーン拡大表示）
  // =====================================================================

  /**
   * 画像をフルスクリーンモーダルで表示する。
   *
   * @param {string} src - 画像の Data URL
   */
  function openImageModal(src) {
    const modal = $('#image-modal');
    $('#modal-image').src = src;
    modal.style.display = 'flex';
  }

  /**
   * 画像モーダルを閉じる。
   * img の src もクリアしてメモリを解放する。
   */
  function closeImageModal() {
    $('#image-modal').style.display = 'none';
    $('#modal-image').src = '';
  }

  // =====================================================================
  // リソース解放（画面遷移時のクリーンアップ）
  // =====================================================================

  /**
   * カメラ・P2P接続・チャット履歴をすべてリセットする。
   * ホーム画面に戻る際など、セッションを完全終了する時に呼び出す。
   */
  function cleanup() {
    // QRスキャナーのカメラを停止
    if (qrScanner) {
      qrScanner.stop().catch(() => {}); // エラーは無視（既に停止済みの場合があるため）
      qrScanner = null;
    }

    // DataConnection を閉じる
    if (conn) {
      conn.close();
      conn = null;
    }

    // Peer インスタンスを破棄（シグナリングサーバーとの接続も切断）
    if (peer) {
      peer.destroy();
      peer = null;
    }

    // チャット履歴をUIからクリア
    $('#chat-messages').innerHTML = '';

    // 受信途中だった画像チャンクデータを破棄
    Object.keys(imageChunks).forEach((k) => delete imageChunks[k]);
  }

  // =====================================================================
  // イベントリスナー登録
  // =====================================================================

  /**
   * アプリケーションの初期化処理。
   * DOMContentLoaded 後に呼ばれ、全ボタン・入力欄のイベントを登録する。
   */
  function init() {
    // ---- ホーム画面 ----------------------------------------
    // 「QRコードを表示する」ボタン → ホスト処理開始
    $('#btn-create').addEventListener('click', startHost);
    // 「QRコードを読み取る」ボタン → ゲスト処理開始
    $('#btn-join').addEventListener('click', startScan);

    // ---- 戻るボタン ----------------------------------------
    // QR表示画面の戻るボタン
    $('#btn-qr-back').addEventListener('click', () => {
      cleanup();
      showScreen('home');
    });
    // QRスキャン画面の戻るボタン
    $('#btn-scan-back').addEventListener('click', () => {
      cleanup();
      showScreen('home');
    });
    // チャット画面の戻るボタン（確認ダイアログあり）
    $('#btn-chat-back').addEventListener('click', () => {
      if (confirm('チャットを終了しますか？')) {
        cleanup();
        showScreen('home');
      }
    });

    // ---- チャット送信 --------------------------------------
    // 送信ボタン押下
    $('#btn-send').addEventListener('click', () => {
      const input = $('#chat-input');
      sendTextMessage(input.value);
      input.value = ''; // 送信後に入力欄をクリア
    });

    // Enterキーでも送信（IME変換中（isComposing）は送信しない）
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault(); // フォームの改行・送信デフォルト動作を抑制
        const input = $('#chat-input');
        sendTextMessage(input.value);
        input.value = '';
      }
    });

    // ---- QRコードスキャン フォールバック ----------------------
    // カメラのリアルタイムスキャンが使えない場合、
    // ネイティブカメラで撮影した写真からQRコードを読み取る
    $('#qr-file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        scanFromFile(file);
      }
      e.target.value = '';
    });

    // ---- 画像送信 ------------------------------------------
    // ファイル選択ダイアログで画像が選ばれた時
    $('#image-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        // 大きな画像は送信前にリサイズして通信量を削減
        resizeImage(file, 1200).then((resizedFile) => {
          sendImage(resizedFile);
        });
      }
      // 同じファイルを連続して選択できるよう value をリセット
      e.target.value = '';
    });

    // ---- 画像モーダル --------------------------------------
    // ×ボタンで閉じる
    $('#btn-modal-close').addEventListener('click', closeImageModal);
    // モーダルの背景（画像の外側）をタップでも閉じる
    $('#image-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeImageModal();
    });

    // ---- Service Worker 登録 -------------------------------
    // PWA としてのオフラインキャッシュ機能を有効化
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.log('SW registration failed:', err);
      });
    }
  }

  // =====================================================================
  // 画像リサイズユーティリティ
  // =====================================================================

  /**
   * 画像ファイルを指定した最大サイズ（px）以内にリサイズして返す。
   *
   * - 200KB 未満のファイルはそのまま返す（処理スキップ）
   * - 縦横比を維持しながらリサイズ
   * - Canvas を使って JPEG 品質 82% で再エンコード
   *
   * @param {File}   file    - 元の画像ファイル
   * @param {number} maxSize - 長辺の最大ピクセル数
   * @returns {Promise<File>} リサイズ後の画像ファイル（または元のファイル）
   */
  function resizeImage(file, maxSize) {
    return new Promise((resolve) => {
      // 200KB 未満は転送量が少ないのでリサイズ不要
      if (file.size < 200000) {
        resolve(file);
        return;
      }

      const img = new Image();
      // Blob URL を作成して img に読み込む
      const url = URL.createObjectURL(file);

      img.onload = () => {
        // Blob URL を解放（メモリリーク防止）
        URL.revokeObjectURL(url);

        let { width, height } = img;

        // 既に最大サイズ以内なら変換不要
        if (width <= maxSize && height <= maxSize) {
          resolve(file);
          return;
        }

        // 縦横比を維持しながら、長辺を maxSize に縮小
        if (width > height) {
          height = Math.round((height * maxSize) / width);
          width = maxSize;
        } else {
          width = Math.round((width * maxSize) / height);
          height = maxSize;
        }

        // Canvas に描画して JPEG として出力
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // JPEG 品質 0.82 で Blob に変換し File オブジェクトとして返す
        canvas.toBlob(
          (blob) => {
            resolve(new File([blob], file.name, { type: 'image/jpeg' }));
          },
          'image/jpeg',
          0.82  // 品質係数（0〜1）: 0.82 で画質と容量のバランスをとる
        );
      };

      img.src = url;
    });
  }

  // =====================================================================
  // エントリポイント
  // =====================================================================

  // DOM の構築完了後に init() を実行する
  document.addEventListener('DOMContentLoaded', init);

})(); // 即時実行関数でグローバルスコープの汚染を防ぐ
