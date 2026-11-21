// Temporary: print what the public Italian XMLTV guides contain, to design the matching.
import zlib from 'node:zlib';
const SRC = (process.argv[2] || 'https://epgshare01.online/epgshare01/epg_ripper_IT1.xml.gz').split(',');
const pl = await (await fetch('https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_italy.m3u8')).text();
const want = [...pl.matchAll(/tvg-id="([^"]*)"[^\n]*,([^\n]*)/g)].map(m => [m[1], m[2].trim()]);
for (const u of SRC) {
  const r = await fetch(u.trim());
  console.log('\n==', u, r.status, r.headers.get('content-length'), r.headers.get('access-control-allow-origin'));
  if (!r.ok) continue;
  let buf = Buffer.from(await r.arrayBuffer());
  if (/\.gz$/.test(u.trim())) buf = zlib.gunzipSync(buf);
  const x = buf.toString('utf8');
  console.log('xml bytes', x.length);
  const chans = [...x.matchAll(/<channel id="([^"]*)">([\s\S]*?)<\/channel>/g)].map(m => [m[1], (/<display-name[^>]*>([^<]*)/.exec(m[2]) || [])[1]]);
  console.log('channels', chans.length);
  console.log(chans.slice(0, 400).map(c => c.join(' = ')).join('\n'));
  const progs = [...x.matchAll(/<programme ([^>]*)>/g)];
  console.log('programmes', progs.length, progs.slice(0, 3).map(m => m[1]).join('\n'));
  const one = /<programme [\s\S]*?<\/programme>/.exec(x); console.log(one && one[0]);
  const ids = new Set(chans.map(c => c[0]));
  const hit = want.filter(([id]) => ids.has(id));
  console.log('Free-TV ids matched', hit.length, '/', want.length);
  console.log('unmatched', want.filter(([id]) => !ids.has(id)).map(w => w.join(' | ')).join('\n'));
}
