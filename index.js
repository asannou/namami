#!/usr/bin/env node

const process = require('process');
const { URL, URLSearchParams } = require('url');
const http = require('http');
const https = require('https');
const net = require('net');
const { PassThrough, Transform } = require('stream');
const WebSocket = require('ws');
const channels = require('./channels.json');
const { debug } = console;

const port = 80;
const ms_port = 2525;
const ms_address = process.argv[2] ?? '127.0.0.1'

const lives = {};
const threads = {};

let local_time, server_time;

function getServerTime() {
  if (server_time) {
    const elapsed_time = getNow() - local_time;
    return Math.round(server_time + elapsed_time);
  } else {
    return getNow();
  }
}

function getNow() {
  return Date.now() / 1000;
}

function getBaseTime(unix_time = getServerTime()) {
  const hour = 60 * 60;
  const day = hour * 24;
  const timezone = hour * 9;
  const offset = timezone - (hour * 4);
  return Math.floor((unix_time + offset) / day) * day - offset + 1;
}

function waitSeconds(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay * 1000));
}

async function httpsRequest(url, options) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, resolve);
    req.on('error', reject);
    req.end();
  });
}

function httpsGet(url, options) {
  debug('get', url.toString());
  return httpsRequest(url, { method: 'GET', ...options });
}

function slurpMessage(message) {
  return new Promise((resolve) => {
    let data = '';
    message.on('data', (chunk) => data += chunk);
    message.on('end', () => resolve(data));
  });
}

async function searchLives(tags, status) {
  const url = new URL('https://live.nicovideo.jp/search');
  url.search = new URLSearchParams({
    status: status,
    sortOrder: 'recentDesc',
    isTagSearch: 'true',
    keyword: tags.join(' ')
  });
  const res = await httpsGet(url);
  const data = await slurpMessage(res);
  const re = new RegExp(
    '<a class="searchPage-ProgramList_ThumbnailLink" href="watch/([^"]+)">\n' +
    '\\s*<div class="searchPage-ProgramList_StatusLabel-(live|future)">', 'g'
  );
  return Array.from(data.matchAll(re)).map((m) => m[1]);
}

async function getEmbeddedData(url) {
  const res = await httpsGet(url);
  const data = await slurpMessage(res);
  const re = /id="embedded-data" data-props="([^"]+)/;
  const embedded_data = data.match(re);
  if (embedded_data) {
    const [, data_props] = embedded_data;
    return JSON.parse(data_props.replace(/&quot;/g, '"'));
  }
}

function createWebSocket(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      webSocketUrl,
      [],
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    let keep_seat;
    ws.on('open', () => {
      debug('ws:open', ws._socket.remoteAddress);
      sendStartWatching(ws);
    })
    ws.on('message', (data) => {
      const message = JSON.parse(data);
      //debug('ws:message', ws._socket.remoteAddress, message);
      switch (message.type) {
        case 'ping': {
          ws.send(JSON.stringify({ "type": "pong" }));
          break;
        }
        case 'serverTime': {
          local_time = getNow();
          const current_ms = new Date(message.data.currentMs);
          server_time = current_ms.getTime() / 1000;
          break;
        }
        case 'seat': {
          keep_seat = setInterval(
            () => ws.send(JSON.stringify({ "type": "keepSeat" })),
            message.data.keepIntervalSec * 1000
          );
          break;
        }
        case 'room': {
          resolve({ room: message, ws });
          break;
        }
        case 'statistics': {
          break;
        }
      }
    });
    ws.on('close', () => {
      debug('ws:close', ws._socket.remoteAddress);
      clearInterval(keep_seat);
    });
    ws.on('error', () => {
      debug('ws:error', ws._socket.remoteAddress);
      reject();
    });
  });
}

function sendStartWatching(ws) {
  return ws.send(JSON.stringify(
    {
      "type": "startWatching",
      "data": {
        "stream": {
          "quality": "high",
          "protocol": "hls",
          "latency": "high",
          "chasePlay": false
        },
        "room": {
          "protocol": "webSocket",
          "commentable": true
        },
        "reconnect": false
      }
    }
  ));
}

function createMessageWebSocket(room, revisionCheckIntervalMs) {
  const { data } = room;
  const mws = new WebSocket(data.messageServer.uri);
  let interval;
  mws.on('open', () => {
    debug('mws:open', mws._socket.remoteAddress);
    mws.send(JSON.stringify(
      [
        { "ping": { "content": "rs:0" } },
        { "ping": { "content": "ps:0" } },
        {
          "thread": {
            "thread": data.threadId,
            "version": "20061206",
            "user_id": "guest",
            "res_from": 0,
            "with_global": 1,
            "scores": 1,
            "nicoru": 0
          }
        },
        { "ping": { "content": "pf:0" } },
        { "ping": { "content": "rf:0" } }
      ]
    ));
    interval = setInterval(() => mws.send(''), revisionCheckIntervalMs);
  });
  mws.on('close', () => {
    debug('mws:close', mws._socket.remoteAddress);
    clearInterval(interval);
  });
  mws.on('error', (error) => {
    debug('mws:error', mws._socket.remoteAddress);
    throw error;
  });
  return mws;
}

function createHttpServer() {
  const handlers = {
    '': handleIndex,
    'tv': handleIndex,
    'radio': handleIndex,
    'bs': handleIndex,
    'watch': handleWatch,
    'api': {
      'v2_app': {
        'getapplicationversion': handleGetApplicationVersion,
        'session.create': handleSessionCreate,
        'session.destroy': handleSessionDestroy,
        'ng.client': handleNg,
        'ng.owner': handleNg,
        'getchannels': handleGetChannels,
        'getflv': handleGetFlv,
        'getpostkey': handleGetPostkey
      },
      'v2': {
        'getchannels': handleGetChannels,
        'getflv': handleGetFlv,
        'getpostkey': handleGetPostkey
      },
      'getpostkey': handleGetPostkey
    }
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const data = await slurpMessage(req);
    if (data) url.search = data;
    debug('req', res.socket.remoteAddress, req.method, url.toString());
    debug(req.headers, data);
    const paths = url.pathname.substring(1).split('/');
    const AsyncFunction = (async () => {}).constructor;
    let handler = handlers;
    for (const path of paths) {
      handler = handler[path];
      if (typeof handler == 'function') {
        if (handler instanceof AsyncFunction) {
          await handler({ url, paths, res });
        } else {
          handler({ url, paths, res });
        }
        res.end();
        return;
      } else if (!handler) {
        break;
      }
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port);
  debug('listen', port);
  return server;
}

function handleGetApplicationVersion({ res }) {
  res.setHeader('Content-Type', 'application/xml; charset=UTF-8');
  res.write('<channels status="ok">\n');
  res.write('<?xml version="1.0" encoding="UTF-8"?>\n');
  res.write('<application>\n');
  res.write('  <platform>windows</platform>\n');
  res.write('  <release>2012-02-09 14:50:59</release>\n');
  res.write('  <version>\n');
  res.write('    <major>1</major>\n');
  res.write('    <minor>2</minor>\n');
  res.write('    <micro>1</micro>\n');
  res.write('    <build>1516</build>\n');
  res.write('  </version>\n');
  res.write('</application>\n');
}

function handleGetChannels({ res }) {
  res.setHeader('Content-Type', 'application/xml; charset=UTF-8');
  res.write('<channels status="ok">\n');
  for (const video of Object.keys(channels)) {
    const channel = channels[video];
    const tagname = channel.bs ? 'bs_channel' :
      channel.radiko_id ? 'radio_channel' : 'channel';
    const id = channel.id ?? parseInt(video.substring(2));
    const thread = getThread(video);
    const last_res = getLastRes(thread);
    res.write(`  <${tagname}>\n`);
    res.write(`    <id>${id}</id>\n`);
    if (channel.radiko_id) {
      res.write(`    <radiko_id>${channel.radiko_id}</radiko_id>\n`);
    } else if (!channel.bs) {
      res.write(`    <no>${id}</no>\n`);
    }
    res.write(`    <name>${channel.name}</name>\n`);
    res.write(`    <video>${video}</video>\n`);
    res.write(`    <thread>\n`);
    res.write(`      <id>${thread.id}</id>\n`);
    res.write(`      <last_res>${escapeChat(last_res)}</last_res>\n`);
    res.write(`      <force>${thread.force}</force>\n`);
    res.write(`    </thread>\n`);
    res.write(`  </${tagname}>\n`);
  }
  res.write('</channels>\n');
}

function getLastRes(thread) {
  const recent_res = thread.recent_res.filter(Boolean).reverse();
  const last_res = recent_res.map((r) => r.content).join(' ');
  if (last_res.length <= 50) return last_res;
  return last_res.substring(0, 50) + '...';
}

function handleGetFlv({ url, res }) {
  const video = url.searchParams.get('v');
  const channel = channels[video];
  let params;
  if (channel) {
    const thread = getThread(video);
    params = new URLSearchParams({
      done: 'true',
      thread_id: thread.id,
      ms: ms_address,
      ms_port: ms_port,
      http_port: 8081,
      channel_no: parseInt(video.substring(2)),
      channel_name: channel.name,
      genre_id: 1,
      twitter_enabled: 1,
      vip_follower_disabled: 0,
      twitter_vip_mode_count: 10000,
      twitter_hashtag: '#namami',
      twitter_api_url: 'http://jk.nicovideo.jp/api/v2/',
      base_time: thread.base_time,
      open_time: thread.open_time,
      start_time: thread.start_time,
      end_time: thread.end_time,
      user_id: 2525,
      is_premium: 0,
      nickname: 'namami'
    });
  } else {
    params = new URLSearchParams({
      code: 1,
      error: 'invalid_thread',
      done: 'true',
    });
  }
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.write(params.toString());
}

function handleGetPostkey({ res }) {
  res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
  res.write('postkey=unavailable');
}

function handleSessionCreate({ res }) {
  res.setHeader('Content-Type', 'application/xml; charset=UTF-8');
  res.write(`<?xml version="1.0" encoding="UTF-8"?>\n`);
  res.write(`<nicovideo_user_response status="ok">\n`);
  res.write(`  <user>\n`);
  res.write(`    <id>2525</id>\n`);
  res.write(`    <username>namami@example.com</username>\n`);
  res.write(`    <password>exist</password>\n`);
  res.write(`    <mail>namami@example.com</mail>\n`);
  res.write(`    <mobile_mail>namami@example.net</mobile_mail>\n`);
  res.write(`    <nickname>namami</nickname>\n`);
  res.write(`    <status>0</status>\n`);
  res.write(`    <prefecture>東京都</prefecture>\n`);
  res.write(`    <birthday>2000-01-01</birthday>\n`);
  res.write(`    <sex>男性</sex>\n`);
  res.write(`    <timezone>Asia/Tokyo</timezone>\n`);
  res.write(`    <country>Japan</country>\n`);
  res.write(`    <area>JP</area>\n`);
  res.write(`    <language>ja-jp</language>\n`);
  res.write(`    <domain>jp</domain>\n`);
  res.write(`    <reminder>reminder</reminder>\n`);
  res.write(`    <answer>answer</answer>\n`);
  res.write(`    <description></description>\n`);
  res.write(`    <option_flag>000000000002000000000000000000000000000001</option_flag>\n`);
  res.write(`    <login_addr>${res.socket.remoteAddress}</login_addr>\n`);
  res.write(`    <login_time>2020-12-01T00:00:00+09:00</login_time>\n`);
  res.write(`    <create_time>2007-01-01T00:00:00+09:00</create_time>\n`);
  res.write(`    <update_time>2020-12-01T00:00:00+09:00</update_time>\n`);
  res.write(`    <thumbnail_url>https://secure-dcdn.cdn.nimg.jp/nicoaccount/usericon/defaults/blank.jpg</thumbnail_url>\n`);
  res.write(`    <is_premium>0</is_premium>\n`);
  res.write(`  </user>\n`);
  res.write(`  <session>namami2525namami</session>\n`);
  res.write(`</nicovideo_user_response>\n`);
}

function handleSessionDestroy({ res }) {
  res.setHeader('Content-Type', 'application/xml; charset=UTF-8');
  res.write(`<?xml version="1.0" encoding="UTF-8"?>\n`);
  res.write(`<nicovideo_user_response status="ok"></nicovideo_user_response>\n`);
}

function handleNg({ res }) {
  res.setHeader('Content-Type', 'application/xml; charset=UTF-8');
  res.write(`<?xml version="1.0" encoding="UTF-8"?>\n`);
  res.write(`<nicovideo_ng_response status="ok">\n`);
  res.write(`  <count>0</count>\n`);
  res.write(`</nicovideo_ng_response>\n`);
}

function handleIndex({ paths, res }) {
  const filters = {
    'tv': (channel) => !channel.radiko_id && !channel.bs,
    'radio': (channel) => channel.radiko_id,
    'bs': (channel) => channel.bs,
  };
  const filter = (key) => filters[paths[0] || 'tv'](channels[key]);
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.write(`<html>`);
  res.write(`<body>`);
  res.write(`<ul>`);
  res.write(`<li><a href="/tv">テレビ</a></li>`);
  res.write(`<li><a href="/radio">ラジオ</a></li>`);
  res.write(`<li><a href="/bs">BS</a></li>`);
  res.write(`</ul>`);
  res.write(`<table>`);
  res.write(`<tr>`);
  res.write(`<th>チャンネル</th>`);
  res.write(`<th>チャンネル名</th>`);
  res.write(`<th>最新のコメント</th>`);
  res.write(`<th>勢い</th>`);
  res.write(`</tr>`);
  for (const video of Object.keys(channels).filter(filter)) {
    const no = parseInt(video.substring(2));
    const channel = channels[video];
    const thread = getThread(video);
    const last_res = getLastRes(thread);
    res.write(`<tr>`);
    res.write(`<td>${no}ch</td>`);
    res.write(`<td><a href="/watch/${video}">${channel.name}</a></td>`);
    res.write(`<td>${escapeChat(last_res)}</td>`);
    res.write(`<td>${thread.force}コメ/分</td>`);
    res.write(`</tr>`);
  }
  res.write(`</table>`);
  res.write(`</body>`);
  res.write(`</html>`);
}

async function handleWatch({ paths, res }) {
  const video = paths[1];
  const thread = getThread(video);
  if (!thread) return;
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.write(`<html>`);
  res.write(`<body>`);
  res.write(`<ul>`);
  for (const live_video of thread.lives) {
    if (!lives[live_video]) break;
    const url = `https://live.nicovideo.jp/watch/${live_video}`;
    res.write(`<li>`);
    res.write(`<a target="_blank" href="${url}">${url}</a>`);
    res.write(`</li>`);
  }
  res.write(`</ul>`);
  res.write(`</body>`);
  res.write(`</html>`);
}

const createWebSocketServer = (port) => {
  const server = net.createServer((socket) => {
    debug('c:connect', socket.localPort, socket.remoteAddress);
    const client = { stream: createClientStream(socket) };
    socket.on('data', (data) => {
      data = data.toString();
      debug('c:data', socket.remoteAddress, data);
      const element = parseElement(data);
      switch (element.name) {
        case 'thread': {
          handleThread(socket, client, element);
          break;
        }
        case 'chat': {
          break;
        }
      }
    });
    socket.on('end', () => {
      debug('c:end', socket.remoteAddress);
    });
    socket.on('close', () => {
      debug('c:close', socket.remoteAddress);
      client.thread_stream?.unpipe(client.stream).resume();
      clearTimeout(client.timeout);
      clearInterval(client.counter);
    });
    socket.on('error', (err) => {
      debug('c:error', socket.remoteAddress, err);
    });
    client.timeout = setTimeout(() => {
      debug('c:timeout', socket.remoteAddress);
      client.leave?.call();
      socket.destroy();
    }, getNextBaseTimeDelay() * 1000);
  });
  server.listen(port);
  debug('s:listen', port);
  return server;
};

function createClientStream(socket) {
  const stream = PassThrough({ objectMode: true }).resume();
  stream.on('pause', () => {
    debug('c:pause', socket.remoteAddress);
    stream.unpipe().resume();
  });
  stream.pipe(socket);
  return stream;
}

function parseElement(element) {
  const parsed = {};
  if (element.startsWith('<')) {
    const [, attribute, content] = element.split(/[<>]/);
    const attributes = attribute.split(/ +/);
    parsed.name = attributes.shift();
    for (const a of attributes) {
      const [name, value] = a.split('=');
      parsed[name] = value?.split(/["']/)[1];
    }
    parsed.content = content;
  }
  debug(parsed);
  return parsed;
}

function handleThread(socket, client, element) {
  const thread = threads[element.thread];
  if (!thread) return;
  if (element.res_from < 0) {
    replayThread(socket, thread, element.res_from);
  } else {
    writeThread(socket, thread);
  }
  client.thread_stream?.unpipe(client.stream).resume();
  client.thread_stream = thread.stream;
  client.thread_stream.pipe(client.stream);
  debug('c:pipe', thread.id, socket.remoteAddress);
  clearInterval(client.counter);
  client.counter = setInterval(() => writeViewCounter(socket, thread), 10000);
  client.leave = () => writeLeaveThread(socket, thread);
}

function replayThread(socket, thread, res_from) {
  const recent_res = thread.recent_res.filter(Boolean).splice(res_from);
  const last_res = thread.last_res - recent_res.length;
  writeThread(socket, { ...thread, last_res });
  for (const res of recent_res) {
    const element = createChatElement(thread, res);
    socket.write(`${element}\0`);
  }
}

function writeThread(socket, thread) {
  const { resultcode, last_res, ticket } = thread;
  const element = `<thread` +
    ` resultcode="${resultcode}"` +
    ` thread="${thread.id}"` +
    ` last_res="${last_res}"` +
    ` ticket="${ticket}"` +
    ` revision="4"` +
    ` server_time="${getServerTime()}"` +
    `/>`;
  socket.write(`${element}\0`);
  debug(element);
}

function writeViewCounter(socket, thread) {
  const id = thread.id - threads[thread.id].base_time + 1;
  const element = `<view_counter video="0" id="${id}"/>`;
  socket.write(`${element}\0`);
  //debug(element);
}

function writeLeaveThread(socket, thread) {
  const element = `<leave_thread` +
    ` thread="${thread.id}"` +
    ` reason="2"` +
    `/>`;
  socket.write(`${element}\0`);
  debug(element);
}

function getNextBaseTimeDelay() {
  const next_base_time = getBaseTime() + 86400;
  return next_base_time - getServerTime();
}

function createThread(thread_id) {
  const recent_length = 50;
  const base_time = getBaseTime(thread_id);
  const thread = {
    resultcode: 0,
    id: thread_id,
    last_res: 0,
    last_min_res: 0,
    recent_res: Array(recent_length),
    ticket: '0x25252525',
    revision: 4,
    base_time: base_time,
    open_time: base_time,
    start_time: base_time,
    end_time: base_time,
    force: 0,
    lives: new Set()
  };
  thread.stream = createTransform(thread);
  thread.stream.resume();
  const prev_thread_id = thread_id - 86400;
  const prev_thread = threads[prev_thread_id];
  if (prev_thread) {
    thread.lives = prev_thread.lives;
    for (const live_video of thread.lives) {
      const live = lives[live_video];
      if (!live) break;
      live.stream.unpipe(prev_thread.stream).resume();
      debug('unpipe', live_video, prev_thread.id);
      live.stream.pipe(thread.stream);
      debug('pipe', live_video, thread.id);
    }
    delete threads[prev_thread_id];
  }
  return thread;
}

function getThread(video) {
  const channel = channels[video];
  if (!channel) return;
  const thread_id = getBaseTime() + channel.thread_id;
  return threads[thread_id];
}

function createTransform(thread) {
  return Transform({
    objectMode: true,
    transform: function(chunk, encoding, callback) {
      chunk.no = ++thread.last_res;
      const element = createChatElement(thread, chunk);
      this.push(`${element}\0`);
      //debug(element);
      thread.recent_res.shift();
      thread.recent_res.push(chunk);
      thread.end_time = chunk.date;
      if (chunk.premium == 3 && chunk.content.startsWith('/')) {
        const commands = chunk.content.split(' ');
        debug(commands);
        if (commands[0] == '/jump') pipeLive(commands[1]);
      }
      callback();
    }
  });
}

function createChatElement(thread, chunk) {
  const {
    no,
    vpos_time,
    date,
    date_usec,
    mail,
    user_id,
    premium,
    anonymity,
    content
  } = chunk;
  const vpos = Math.round((vpos_time - thread.base_time) * 100);
  return `<chat` +
    ` thread="${thread.id}"` +
    ` no="${no}"` +
    ` vpos="${vpos}"` +
    ` date="${date}"` +
    ` date_usec="${date_usec}"` +
    (mail ? ` mail="${mail}"` : '') +
    ` user_id="${user_id}"` +
    (premium ? ` premium="${premium}"` : '') +
    (anonymity ? ` anonymity="${anonymity}"` : '') +
    `>` +
    escapeChat(content) +
    `</chat>`;
}

function escapeChat(string) {
  return string.
    replace(/&/g, '&amp;').
    replace(/</g, '&lt;').
    replace(/>/g, '&gt;');
}

function getLive(video) {
  return new Promise((resolve) => {
    if (lives[video]) return resolve(lives[video]);
    lives[video] = { stream: PassThrough({ objectMode: true }).resume() };
    (async () => {
      const retry = 3;
      for (let i = 0; i < retry; i++) {
        const live = await watchLive(video);
        if (!live) break;
        const { tags, stream, promise } = live;
        lives[video].tags = tags;
        resolve(lives[video]);
        stream.pipe(lives[video].stream);
        await promise;
        stream.unpipe(lives[video].stream).resume();
        await waitSeconds(10);
      }
      delete lives[video];
      debug('delete', video);
      resolve({ tags: [] });
    })();
  });
}

async function watchLive(video) {
  const url = `https://live2.nicovideo.jp/watch/${video}`;
  const embedded_data = await getEmbeddedData(url);
  if (!embedded_data) return;
  const { program: { tag, status } } = embedded_data;
  const watchable = new Set(['RELEASED', 'ON_AIR']);
  if (!watchable.has(status)) return;
  //const tags = tag.list.filter((t) => t.isLocked).map((t) => t.text);
  const tags = tag.list.map((t) => t.text);
  debug('watch', video, tags);
  const stream = PassThrough({ objectMode: true }).resume();
  const promise = promiseWatchLive(url, embedded_data, stream);
  return { tags, stream, promise };
}

async function promiseWatchLive(url, embedded_data, stream) {
  const {
    site: { relive: { webSocketUrl }, tag: { revisionCheckIntervalMs } },
    program: { beginTime, vposBaseTime },
  } = embedded_data;
  const getWebSocketUrl = async () => {
    debug('wait', url);
    await waitSeconds(beginTime - getServerTime());
    const embedded_data = await getEmbeddedData(url);
    return embedded_data?.site.relive.webSocketUrl;
  }
  const ws_url = webSocketUrl || await getWebSocketUrl();
  if (!ws_url) return;
  const { room, ws } = await createWebSocket(ws_url);
  const mws = createMessageWebSocket(room, revisionCheckIntervalMs);
  mws.on('message', (data) => {
    debug(data);
    const message = JSON.parse(data);
    //debug('mws:message', mws._socket.remoteAddress, message);
    const { chat } = message;
    if (chat) {
      chat.vpos_time = vposBaseTime + chat.vpos / 100;
      stream.write(chat);
      //debug(chat);
    }
  });
  await new Promise((resolve) => {
    ws.on('close', () => {
      mws.close();
      resolve();
    });
    mws.on('close', () => {
      ws.close();
      resolve();
    });
  });
}

function createThreads() {
  for (const channel of Object.values(channels)) {
    const thread_id = getBaseTime() + channel.thread_id;
    threads[thread_id] = createThread(thread_id);
  }
  setTimeout(() => createThreads(), getNextBaseTimeDelay() * 1000);
}

async function setPipesInterval() {
  const delay = 300;
  const pipe = async () => {
    await pipeLives(['ニコニコ実況']);
    await pipeLives(['niconews24'], ['jk10']);
    await pipeLives(['ウェザーニュースLiVE'], ['jk11']);
    await pipeLives(['北朝鮮', '朝鮮中央テレビ'], ['jk12']);
  };
  await pipe();
  return setInterval(pipe, delay * 1000);
}

function setForceInterval() {
  const delay = 60;
  return setInterval(() => {
    for (const video of Object.keys(channels)) {
      const thread = getThread(video);
      if (thread) {
        thread.force = thread.last_res - thread.last_min_res;
        thread.last_min_res = thread.last_res;
      }
    }
  }, delay * 1000);
}

async function pipeLives(tags, videos) {
  for (const status of ['onair', 'reserved']) {
    for (const live_video of await searchLives(tags, status)) {
      await pipeLive(live_video, videos);
    }
  }
}

async function pipeLive(live_video, videos) {
  const { tags, stream } = await getLive(live_video);
  const threads = videos ? videos.map(getThread) : tags.map(getThreadByTag);
  for (const thread of threads.filter(Boolean)) {
    if (!isPiped(stream, thread.stream)) {
      stream.pipe(thread.stream);
      debug('pipe', live_video, thread.id);
      thread.lives.add(live_video);
    }
  }
}

function getThreadByTag(tag) {
  const video = tag.startsWith('jk') ? tag :
    Object.keys(channels).find((key) => channels[key].tags?.includes(tag));
  return getThread(video);
}

function isPiped(src, dest) {
  return src._readableState.pipes.includes(dest);
}

(async function () {
  createThreads();
  await setPipesInterval();
  setForceInterval();
  createHttpServer();
  createWebSocketServer(ms_port);
})()

