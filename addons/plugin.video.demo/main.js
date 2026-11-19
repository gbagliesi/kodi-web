// The simplest possible add-on: a static catalogue.
// list(path) returns the items of a "folder"; playable items carry a url.
const BASE = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/';

const FILMS = [
  { label: 'Big Buck Bunny', file: 'BigBuckBunny.mp4', thumb: 'images/BigBuckBunny.jpg', year: 2008, plot: 'Un coniglio gigante si vendica di tre roditori dispettosi.' },
  { label: 'Elephants Dream', file: 'ElephantsDream.mp4', thumb: 'images/ElephantsDream.jpg', year: 2006, plot: 'Il primo film open source della Blender Foundation.' },
  { label: 'Sintel', file: 'Sintel.mp4', thumb: 'images/Sintel.jpg', year: 2010, plot: 'Una ragazza cerca il suo cucciolo di drago.' },
  { label: 'Tears of Steel', file: 'TearsOfSteel.mp4', thumb: 'images/TearsOfSteel.jpg', year: 2012, plot: 'Fantascienza ad Amsterdam, girato con attori reali.' },
];

const HLS = [
  { label: 'Test HLS (Mux)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { label: 'Test HLS fMP4 (Apple)', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8' },
];

addon.register({
  async list(path) {
    if (!path) {
      return {
        view: 'list',
        items: [
          { label: 'Cortometraggi Blender', path: 'films', subtitle: 'MP4 progressivo' },
          { label: 'Stream HLS di test', path: 'hls', subtitle: 'Adaptive streaming .m3u8' },
        ],
      };
    }
    if (path === 'films') {
      return {
        view: 'wide',
        items: FILMS.map(f => ({
          label: f.label,
          url: BASE + f.file,
          thumb: BASE + f.thumb,
          playable: true,
          type: 'video',
          info: { year: f.year, plot: f.plot },
        })),
      };
    }
    if (path === 'hls') {
      return { view: 'list', items: HLS.map(s => ({ ...s, playable: true, type: 'video', mime: 'application/vnd.apple.mpegurl' })) };
    }
    return [];
  },
});
