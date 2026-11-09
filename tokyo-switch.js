/* tokyo-switch — a dark mode switch with a small pixel Tokyo living inside it.
 *
 * Idea after "住人のいるスイッチ" by @Lattice_Node (ludion.ai/p/toggle-daylight, MIT).
 * The scene, the renderer and the shaders here are written from scratch.
 *
 *   <script src="tokyo-switch.js"></script>
 *   <tokyo-switch></tokyo-switch>
 *
 *   el.checked                 true = night
 *   el.position                0..1, sets the lens directly (no animation)
 *   'change' event             detail: { night }
 *   'scrub' event              detail: { position, hour, dark }, fires while the hours move
 *
 * World: indexed pixels at low resolution. Hours change by swapping dithered palettes, so no in-between colours.
 * Lights: each sign belongs to a group that ignites on its own, stutter included.
 * Shell: WebGL draws the bezel, neon tube, rain on the glass and the lens.
 */
(() => {
  // Logical scene is 320x150. The buffer has spare sky and street so wider windows still have something to show.
  const PAD_X = 40;
  const PAD_Y = 40;
  const BW = 400;
  const BH = 190;
  const GROUND = 118;
  const ROAD = 127;
  const HOUR_DAY = 12;
  const HOUR_NIGHT = 22;

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const pack = (c) => (255 << 24) | (Math.round(clamp(c[2]) * 255) << 16) | (Math.round(clamp(c[1]) * 255) << 8) | Math.round(clamp(c[0]) * 255);

  // ---- Palette: one painted colour per material, graded for each time of day
  const NOON = 0, GOLD = 1, DUSK = 2, NIGHT = 3, DAWN = 4;
  const GRADE = [
    ([r, g, b]) => [r, g, b],
    ([r, g, b]) => [r * 1.02 + 0.02, g * 0.82, b * 0.66],
    ([r, g, b]) => [r * 0.5 + 0.03, g * 0.36 + 0.01, b * 0.58 + 0.07],
    ([r, g, b]) => [r * 0.17 + 0.015, g * 0.17 + 0.02, b * 0.3 + 0.065],
    ([r, g, b]) => [r * 0.6 + 0.04, g * 0.52 + 0.02, b * 0.66 + 0.06],
  ];
  const MATS = [null];
  const M = {};
  const mat = (name, hex, over = {}) => {
    M[name] = MATS.length;
    const base = rgb(hex);
    MATS.push(GRADE.map((grade, key) => pack(over[key] ? rgb(over[key]) : grade(base))));
  };
  // Distance
  mat('FAR1', '#b4cfde', { [GOLD]: '#d9a78f', [DUSK]: '#4d3274', [NIGHT]: '#17143f', [DAWN]: '#8d7aa8' });
  mat('FAR2', '#98b8cc', { [GOLD]: '#b98a80', [DUSK]: '#3c2a66', [NIGHT]: '#111135', [DAWN]: '#6f648f' });
  mat('FAR3', '#7f9fb4', { [GOLD]: '#94707a', [DUSK]: '#2f2358', [NIGHT]: '#0e0e2c', [DAWN]: '#585278' });
  mat('FUJI', '#7d9cc4', { [GOLD]: '#8a6a9c', [DUSK]: '#3c2a70', [NIGHT]: '#10123a', [DAWN]: '#6d6aa0' });
  mat('FUJI_DK', '#6b8bb4', { [GOLD]: '#775c90', [DUSK]: '#332463', [NIGHT]: '#0d0f32', [DAWN]: '#5e5c92' });
  mat('SNOW', '#f5f8fc', { [GOLD]: '#ffd9b8', [DUSK]: '#a06a9e', [NIGHT]: '#2c2d5c', [DAWN]: '#f5c6c4' });
  mat('TOWER_R', '#e4502f', { [NIGHT]: '#5a2030' });
  mat('TOWER_W', '#f4efe4', { [NIGHT]: '#5a3a42' });
  mat('CLOUD', '#ffffff', { [GOLD]: '#ffd9b0', [DUSK]: '#e88aa0', [NIGHT]: '#2a2358', [DAWN]: '#ffc9b8' });
  mat('CLOUD_SH', '#dbe9f2', { [GOLD]: '#f2a98c', [DUSK]: '#a0568e', [NIGHT]: '#1d1a48', [DAWN]: '#d99aa8' });
  // Rail
  mat('STEEL', '#6c787c');
  mat('STEEL_DK', '#4b555a');
  mat('STEEL_LT', '#8b979a');
  mat('CONC', '#bdb7a9');
  mat('CONC_DK', '#938e81');
  mat('CONC_LT', '#d1ccbf');
  mat('WIRE', '#3d444a', { [NIGHT]: '#0a0a18' });
  mat('TRAIN', '#dfe2e1');
  mat('TRAIN_DK', '#a9aeae');
  mat('TRAIN_STRIPE', '#3fa85a');
  mat('TRAIN_ROOF', '#7c8486');
  mat('TRAIN_GLASS', '#2f3d4a');
  mat('TRAIN_UNDER', '#333a3f');
  // Buildings
  mat('TILE', '#d8c6a4');
  mat('TILE_DK', '#bba988');
  mat('TILE_LT', '#e6d6b8');
  mat('GREY', '#a9aca9');
  mat('GREY_DK', '#8a8e8c');
  mat('BRICK', '#a9654c');
  mat('BRICK_DK', '#8a4f3c');
  mat('TEAL', '#6f9d99');
  mat('TEAL_DK', '#567e7c');
  mat('CREAM', '#ece2cb');
  mat('CREAM_DK', '#cec2a6');
  mat('SLATE', '#4b5364');
  mat('SLATE_DK', '#3a4152');
  mat('SLATE_LT', '#5c6578');
  mat('INK', '#2b2c37');
  mat('INK_DK', '#1f2029');
  mat('ROOF', '#7b7f7e');
  mat('TANK', '#c4c7c2');
  mat('TANK_DK', '#9a9e9a');
  mat('RAIL_B', '#6f7577');
  mat('GLASS', '#5f83a0', { [GOLD]: '#ffb765', [DUSK]: '#57457f', [NIGHT]: '#15183a', [DAWN]: '#c97f8c' });
  mat('GLASS_HI', '#a6cbdc', { [GOLD]: '#ffe0a6', [DUSK]: '#8b6a98', [NIGHT]: '#1d2048', [DAWN]: '#f2b6a6' });
  mat('GLASS_DK', '#44607a', { [GOLD]: '#cf8450', [DUSK]: '#3f3268', [NIGHT]: '#101230', [DAWN]: '#9c6a80' });
  mat('AC', '#d3d4cc');
  mat('AC_DK', '#9b9d96');
  // Old shop
  mat('KAWARA', '#4f5968');
  mat('KAWARA_HI', '#6b7787');
  mat('KAWARA_DK', '#3a4350');
  mat('WOOD', '#7e5a3b');
  mat('WOOD_DK', '#5a3e29');
  mat('WOOD_LT', '#a37b52');
  mat('PLASTER', '#ece4d0');
  mat('NOREN', '#26478a');
  mat('NOREN_W', '#eef0ee');
  mat('LANTERN', '#d33b2c');
  mat('LANTERN_DK', '#9a2820');
  mat('SHUTTER', '#9ba1a5');
  mat('SHUTTER_DK', '#858b90');
  mat('ROOM', '#3a3430');
  // Sakura keeps a little colour at night, lit from below
  mat('SAK1', '#f9cdd9', { [NIGHT]: '#6b3a70', [DUSK]: '#b9648f' });
  mat('SAK2', '#f4afc4', { [NIGHT]: '#552f62', [DUSK]: '#9c5487' });
  mat('SAK3', '#e78fac', { [NIGHT]: '#3f2650', [DUSK]: '#7f4579' });
  mat('SAK4', '#ffe7ee', { [NIGHT]: '#84487e', [DUSK]: '#d27a9c' });
  mat('BARK', '#5a4337');
  mat('BARK_LT', '#755a4a');
  // Street
  mat('ROAD', '#5d6168', { [NIGHT]: '#0d0f26' });
  mat('ROAD_D', '#54585f', { [NIGHT]: '#0b0d21' });
  mat('ROAD_L', '#686c73', { [NIGHT]: '#10122c' });
  mat('LINE', '#ebe8dd', { [NIGHT]: '#35375a' });
  mat('CURB', '#a8a69c', { [NIGHT]: '#262749' });
  mat('WALK', '#c2bdaf', { [NIGHT]: '#1d1e3d' });
  mat('WALK_D', '#b2ad9f', { [NIGHT]: '#191a37' });
  mat('TACTILE', '#e6c23f', { [NIGHT]: '#4a3f3a' });
  mat('POLE', '#77746c');
  mat('POLE_DK', '#5c5a53');
  mat('MANHOLE', '#474a50', { [NIGHT]: '#17182f' });
  // Signs, off
  mat('BOARD_K', '#23242e', { [NIGHT]: '#0b0b16', [DUSK]: '#16142a' });
  mat('BOARD_W', '#f2eee2');
  mat('BOARD_Y', '#f2c733');
  mat('BOARD_R', '#d63a33');
  mat('BOARD_P', '#ec6ea0');
  mat('BOARD_B', '#2f6fc0');
  mat('BOARD_G', '#3a9c5c');
  mat('BOARD_V', '#7c5cc4');
  mat('BOARD_O', '#ea8a35');
  mat('TUBE', '#b8b8ae', { [NIGHT]: '#2a2a48' });
  mat('PAINT_K', '#1c1c24');
  mat('LAMP_OFF', '#3b3f44', { [NIGHT]: '#16162a' });
  // Vending
  mat('VEND_R', '#d03a33');
  mat('VEND_B', '#2c66b8');
  mat('VEND_W', '#e8e8e2');
  mat('VEND_DK', '#262a30');
  // People and things
  mat('SKIN', '#f0c8a0');
  mat('HAIR', '#23201f');
  mat('SUIT', '#2d3648');
  mat('SHIRT', '#f2f2ec');
  mat('SAILOR', '#25305c');
  mat('SKIRT', '#d36a7c');
  mat('COAT', '#b28a5c');
  mat('RANDO', '#c42b2b');
  mat('UMB', '#dbe8ee', { [NIGHT]: '#5a6a96', [DUSK]: '#a58fb0' });
  mat('CAT_W', '#f1ebdf', { [NIGHT]: '#6f6a8a' });
  mat('CAT_O', '#dc8a3c', { [NIGHT]: '#5a3a4a' });
  mat('CAT_K', '#2a2622');
  mat('CROW', '#1a1a22');
  mat('TIRE', '#17181c');
  mat('CAR_K', '#23252c', { [NIGHT]: '#3e526c' });
  mat('CAR_R', '#c23a33');
  mat('CAR_W', '#e8e8e4', { [NIGHT]: '#8c9caf' });
  mat('CAR_B', '#3f6ca8');
  mat('CAR_Y', '#e5b93a', { [NIGHT]: '#ad8c45' });
  mat('CAR_DK', '#14151a', { [NIGHT]: '#202d43' });
  mat('CAR_GLASS', '#7da3bc', { [NIGHT]: '#1e304b' });
  mat('SMOKE', '#f4f1ea', { [NIGHT]: '#5b5478', [DUSK]: '#b98fa8' });
  mat('PETAL', '#fbd3df', { [NIGHT]: '#7a4a80' });
  mat('MOON', '#f2eddc', { [DUSK]: '#f8d9c0' });
  mat('MOON_DK', '#cfc9b4', { [DUSK]: '#d8b4a8' });
  mat('STAR', '#ffffff');
  mat('POSTER_A', '#e0604f');
  mat('POSTER_B', '#3f9fb0');
  mat('POSTER_C', '#e6c75a');
  mat('CRATE', '#c2513f');
  mat('FUTON', '#f0e4c8');
  mat('FUTON_B', '#7ea2c8');
  mat('SHIRT_B', '#8fb4d6');
  mat('SHIRT_P', '#eba7bc');

  const STREET_MATS = new Set([M.ROAD, M.ROAD_D, M.ROAD_L, M.LINE, M.MANHOLE, M.WALK, M.WALK_D, M.TACTILE, M.CURB]);

  // Sky ramps, top to horizon
  const SKY = [
    ['#6db6e4', '#88c8ec', '#a6d9f1', '#c5e8f3', '#e4f4f1'],
    ['#5b83c6', '#8c9ad0', '#c9a7bf', '#f4b98d', '#ffcf88'],
    ['#1c2563', '#3a2c7e', '#7c3d96', '#d94f7e', '#ff8a58'],
    ['#060920', '#090d29', '#10123a', '#21134a', '#4a1a60'],
    ['#1a295d', '#44508f', '#9a7fb0', '#eaa2a0', '#ffd2a1'],
  ].map((stops) => stops.map((s) => pack(rgb(s))));
  const SKY_END = PAD_Y + 106;
  const STEPS = 5;
  const mixPacked = (a, b, t) => {
    const ch = (s) => Math.round(mix((a >>> s) & 255, (b >>> s) & 255, t)) << s;
    return (255 << 24) | ch(16) | ch(8) | ch(0);
  };

  // Hour -> palette. Hours run 12..36 so the way back goes through dawn instead of rewinding.
  const KEYS = [[12, NOON], [15, NOON], [17, GOLD], [18.5, DUSK], [19.7, NIGHT], [28.6, NIGHT], [29.8, DAWN], [31.4, NOON], [36, NOON]];

  // ---- Neon: core is the bright tube, glow is what spills into the bloom
  const NEONS = [];
  const N = {};
  const neon = (name, core, glow, em = 1) => {
    N[name] = NEONS.length;
    const c = rgb(core);
    const g = rgb(glow);
    NEONS.push({ core: pack(c), r: g[0] * 255 * em, g: g[1] * 255 * em, b: g[2] * 255 * em });
  };
  neon('NONE', '#000000', '#000000', 0);
  neon('PINK', '#ffd6e8', '#ff2a8c');
  neon('CYAN', '#d4fdff', '#14e0ff');
  neon('YELLOW', '#fff5bd', '#ffc51a');
  neon('RED', '#ffcfc4', '#ff2424');
  neon('GREEN', '#d4ffdd', '#1fee78');
  neon('VIOLET', '#e9daff', '#9a50ff');
  neon('ORANGE', '#ffe6c0', '#ff851a');
  neon('WHITE', '#ffffff', '#d8e6ff');
  // Backlit boards: flat colour and softer glow
  neon('B_WHITE', '#fbf6e6', '#ffe9c0', 0.34);
  neon('B_YELLOW', '#ffd63a', '#ffb81a', 0.42);
  neon('B_RED', '#ff4a3f', '#ff2418', 0.48);
  neon('B_PINK', '#ff5fa8', '#ff2a8c', 0.5);
  neon('B_BLUE', '#2f8fff', '#1a70ff', 0.55);
  neon('B_GREEN', '#2fd87a', '#12c060', 0.48);
  neon('B_VIOLET', '#a06cff', '#8040ff', 0.55);
  neon('B_ORANGE', '#ff9a3a', '#ff7a14', 0.48);
  // Rooms
  neon('WARM', '#e9ae62', '#ff9a30', 0.15);
  neon('WARM_DIM', '#d99a58', '#c06a20', 0.1);
  neon('FLUO', '#b4d8ec', '#a8d4ff', 0.14);
  neon('ROOM_P', '#c64a86', '#ff3a8c', 0.16);
  neon('ROOM_C', '#3aa3ba', '#20c0e0', 0.15);
  neon('STORE', '#eef6ff', '#d0e8ff', 0.4);
  // Fixed lights
  neon('TOWER', '#ffc774', '#ff7a1a', 0.5);
  neon('TOWER_HOT', '#fff0c8', '#ff9a30', 0.7);
  neon('LANTERN', '#ff7a4f', '#ff3a18', 0.7);
  neon('LANTERN_HOT', '#ffd08a', '#ff5a20', 0.8);
  neon('BEACON', '#ff4a3a', '#ff1a10', 1);
  neon('HEAD', '#fffbe8', '#ffeec0', 1);
  neon('TAIL', '#ff3a30', '#ff1408', 0.8);
  neon('SIG_BLUE', '#5ffff0', '#14e0c8', 0.9);
  neon('SIG_YELLOW', '#ffe05a', '#ffb814', 0.9);
  neon('SIG_RED', '#ff5046', '#ff1a10', 0.9);
  neon('LED', '#ffb648', '#ff8a14', 0.75);
  neon('EMBER', '#ffb060', '#ff5a10', 0.7);
  neon('EYE', '#c8ff9a', '#80ff40', 0.5);
  neon('SUN', '#fffbe6', '#ffd67a', 0.42);
  neon('SUN_LOW', '#ffe8a0', '#ff7a2a', 0.85);
  neon('MOON_GLOW', '#f8f3e2', '#bfc8ff', 0.3);
  neon('SPARK', '#e8f4ff', '#6aa8ff', 1);
  neon('STAR', '#dfe6ff', '#8090ff', 0.12);

  // ---- Bitmap type
  const GLYPH = {
    東: ['#######', '...#...', '.#####.', '.#.#.#.', '.#####.', '..###..', '##.#.##'],
    京: ['...#...', '#######', '.#####.', '.#...#.', '.#####.', '...#...', '##.#.##'],
    夜: ['...#...', '#######', '.#.#...', '##.###.', '.#.#.#.', '.#..#..', '.#.#.##'],
    酒: ['#.#####', '...#.#.', '#.#####', '..#.#.#', '#.#####', '#.#...#', '#.#####'],
    肉: ['...#...', '#######', '#..#..#', '#.#.#.#', '##...##', '#.....#', '#....##'],
    湯: ['#.#####', '..#...#', '#.#####', '..#...#', '#.#####', '#..#.#.', '#.#.#.#'],
    大: ['...#...', '...#...', '#######', '...#...', '..#.#..', '.#...#.', '#.....#'],
    ラ: ['#####', '.....', '#####', '....#', '...#.', '..#..', '##...'],
    ー: ['..#..', '..#..', '..#..', '..#..', '..#..'],
    '－': ['.....', '.....', '#####', '.....', '.....'],
    メ: ['....#', '#...#', '.#.#.', '..#..', '.#.#.', '#....', '.....'],
    ン: ['#....', '.#..#', '....#', '....#', '...#.', '..#..', '##...'],
    カ: ['..#..', '#####', '..#.#', '..#.#', '.#..#', '.#..#', '#.##.'],
    オ: ['...#.', '#####', '...#.', '..##.', '.#.#.', '#..#.', '..##.'],
    ケ: ['.#...', '.####', '#..#.', '...#.', '...#.', '..#..', '.#...'],
    ホ: ['..#..', '#####', '..#..', '.###.', '#.#.#', '#.#.#', '.##..'],
    テ: ['.###.', '.....', '#####', '..#..', '..#..', '.#...', '#....'],
    ル: ['.#.#.', '.#.#.', '.#.#.', '.#.#.', '.#.#.', '#..##', '#..#.'],
    ス: ['#####', '....#', '...#.', '..#..', '.#.#.', '#...#', '.....'],
    ナ: ['..#..', '#####', '..#..', '..#..', '..#..', '.#...', '#....'],
    ッ: ['.....', '#.#.#', '#.#.#', '....#', '...#.', '.##..', '.....'],
    ク: ['.#...', '.####', '#...#', '....#', '...#.', '..#..', '##...'],
    バ: ['...#.#', '.#....', '.#..#.', '#...#.', '#....#', '#....#', '......'],
    ゲ: ['.#...#.#', '.####...', '#..#....', '...#....', '...#....', '..#.....', '.#......'],
    ム: ['..#..', '..#..', '.#...', '.#.#.', '#...#', '#####', '.....'],
  };
  const ROOF_TO = [
    '......#......',
    '#############',
    '......#......',
    '..#########..',
    '..#...#...#..',
    '..#########..',
    '..#...#...#..',
    '..#########..',
    '.....###.....',
    '...##.#.##...',
    '.##...#...##.',
    '#.....#.....#',
    '......#......',
  ];
  const ROOF_KYO = [
    '......#......',
    '#############',
    '.............',
    '..#########..',
    '..#.......#..',
    '..#.......#..',
    '..#########..',
    '......#......',
    '......#......',
    '..#...#...#..',
    '.#....#....#.',
    '#.....#.....#',
    '....###......',
  ];
  const FONT3 = {
    0: '###,#.#,#.#,#.#,###', 1: '.#.,##.,.#.,.#.,###', 2: '###,..#,###,#..,###', 3: '###,..#,.##,..#,###', 4: '#.#,#.#,###,..#,..#',
    5: '###,#..,###,..#,###', 6: '###,#..,###,#.#,###', 7: '###,..#,..#,.#.,.#.', 8: '###,#.#,###,#.#,###', 9: '###,#.#,###,..#,###',
    ':': '...,.#.,...,.#.,...', A: '###,#.#,###,#.#,#.#', B: '##.,#.#,##.,#.#,##.', C: '###,#..,#..,#..,###', D: '##.,#.#,#.#,#.#,##.',
    E: '###,#..,##.,#..,###', G: '###,#..,#.#,#.#,###', H: '#.#,#.#,###,#.#,#.#', I: '###,.#.,.#.,.#.,###', K: '#.#,#.#,##.,#.#,#.#',
    L: '#..,#..,#..,#..,###', M: '#...#,##.##,#.#.#,#...#,#...#', N: '#..#,##.#,#.##,#..#,#..#', O: '###,#.#,#.#,#.#,###', P: '###,#.#,###,#..,#..',
    R: '##.,#.#,##.,#.#,#.#', S: '###,#..,###,..#,###', T: '###,.#.,.#.,.#.,.#.', U: '#.#,#.#,#.#,#.#,###', W: '#.#,#.#,###,###,#.#',
    Y: '#.#,#.#,###,.#.,.#.', ' ': '...,...,...,...,...',
  };
  for (const key of Object.keys(FONT3)) FONT3[key] = FONT3[key].split(',');

  // ---- World
  class World {
    constructor() {
      const n = BW * BH;
      this.smat = new Uint8Array(n);
      this.sneon = new Uint8Array(n);
      this.sgroup = new Uint8Array(n);
      this.sdepth = new Uint8Array(n);
      this.fmat = new Uint8Array(n);
      this.fneon = new Uint8Array(n);
      this.fgroup = new Uint8Array(n);
      this.rgba = new Uint8Array(n * 4);
      this.pix = new Uint32Array(this.rgba.buffer);
      this.emit = new Uint8Array(n * 4);
      this.mat = this.smat;
      this.neon = this.sneon;
      this.group = this.sgroup;
      this.depth = 0;
      this.groups = [null, { fixed: 1, level: 1 }, { fixed: 2, level: 0 }];
      this.beacons = [];
      this.stars = [];
      this.t = 0;
      this.dark = 0;
      this.rain = 0;
      this.palA = new Uint32Array(MATS.length);
      this.palB = new Uint32Array(MATS.length);
      this.rowLoA = new Uint32Array(BH);
      this.rowHiA = new Uint32Array(BH);
      this.rowLoB = new Uint32Array(BH);
      this.rowHiB = new Uint32Array(BH);
      this.pair = -1;
      this.colR = new Float32Array(BW);
      this.colG = new Float32Array(BW);
      this.colB = new Float32Array(BW);
      this.levels = new Float32Array(256);
      this.levels[1] = 1;
      this.shimmer = new Int8Array(1024);
      const r = rng(7);
      for (let i = 0; i < 1024; i++) this.shimmer[i] = Math.round((r() - 0.5) * 6);
      this.buildSky();
      this.buildStatic();
      this.buildActors();
    }

    // Light groups. Hours are on the 12..36 clock.
    addGroup(on, off, kind = 'neon', opts = {}) {
      this.groups.push({ on, off, kind, level: 0, want: false, ign: 0, seed: this.groups.length * 0.37, ...opts });
      return this.groups.length - 1;
    }

    // ---- Paint
    px(x, y, m) {
      const bx = x + PAD_X;
      const by = y + PAD_Y;
      if (bx < 0 || by < 0 || bx >= BW || by >= BH) return;
      const i = by * BW + bx;
      this.mat[i] = m;
      this.neon[i] = 0;
      this.group[i] = 0;
      if (this.mat === this.smat) this.sdepth[i] = this.depth;
    }
    // Paints only over sky, or behind the near buildings
    pxSky(x, y, m) {
      const bx = x + PAD_X;
      const by = y + PAD_Y;
      if (bx < 0 || by < 0 || bx >= BW || by >= BH) return;
      const i = by * BW + bx;
      if (this.smat[i] !== 0) return;
      this.mat[i] = m;
      this.neon[i] = 0;
      this.group[i] = 0;
    }
    // Paints unless the tree is in the way
    pxBack(x, y, m) {
      const i = (y + PAD_Y) * BW + x + PAD_X;
      if (i >= 0 && i < this.smat.length && this.sdepth[i] < 3) this.px(x, y, m);
    }
    rectBack(x, y, w, h, m) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.pxBack(x + i, y + j, m);
    }
    pxBehind(x, y, m, n = 0, g = 0) {
      const bx = x + PAD_X;
      const by = y + PAD_Y;
      if (bx < 0 || by < 0 || bx >= BW || by >= BH) return;
      const i = by * BW + bx;
      if (this.sdepth[i] > 1) return;
      this.mat[i] = m;
      this.neon[i] = n;
      this.group[i] = g;
    }
    rect(x, y, w, h, m) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, m);
    }
    light(x, y, n, g) {
      const bx = x + PAD_X;
      const by = y + PAD_Y;
      if (bx < 0 || by < 0 || bx >= BW || by >= BH) return;
      const i = by * BW + bx;
      this.neon[i] = n;
      this.group[i] = g;
    }
    lightRect(x, y, w, h, n, g) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.light(x + i, y + j, n, g);
    }
    // A lit pixel with an off colour underneath
    tube(x, y, m, n, g) {
      this.px(x, y, m);
      this.light(x, y, n, g);
    }
    sprite(rows, map, x, y, flip = false) {
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        for (let i = 0; i < row.length; i++) {
          const m = map[row[i]];
          if (m) this.px(flip ? x + row.length - 1 - i : x + i, y + j, m);
        }
      }
    }
    glyph(ch, x, y, cb) {
      const rows = GLYPH[ch] || FONT3[ch];
      if (!rows) return 0;
      for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) if (rows[j][i] === '#') cb(x + i, y + j);
      return rows[0].length;
    }
    // Vertical sign. mode 'tube': neon on a dark board. 'lit': glowing board with dark letters.
    vsign(x, y, text, opts) {
      const { n, g, board = M.BOARD_K, off = M.TUBE, w = 9, mode = 'tube', pad = 2 } = opts;
      const chars = [...text];
      const heights = chars.map((c) => (GLYPH[c] ? GLYPH[c].length : 5));
      const total = heights.reduce((a, b) => a + b + 1, 0) + pad * 2 - 1;
      this.rect(x, y, w, total, board);
      this.rect(x + w - 1, y, 1, total, M.PAINT_K);
      if (mode === 'lit') this.lightRect(x, y, w - 1, total, n, g);
      let cy = y + pad;
      chars.forEach((c, i) => {
        const gw = (GLYPH[c] || FONT3[c] || FONT3[' '])[0].length;
        const gx = x + Math.floor((w - 1 - gw) / 2);
        this.glyph(c, gx, cy, (px, py) => {
          if (mode === 'lit') this.px(px, py, M.PAINT_K);
          else this.tube(px, py, off, n, g);
        });
        cy += heights[i] + 1;
      });
      this.rect(x + 1, y - 1, 1, 1, M.STEEL_DK);
      this.rect(x + w - 3, y + total, 1, 1, M.STEEL_DK);
      return total;
    }
    hsign(x, y, w, h, text, opts) {
      const { n, g, board = M.BOARD_K, off = M.TUBE, mode = 'tube' } = opts;
      this.rect(x, y, w, h, board);
      if (mode === 'lit') this.lightRect(x, y, w, h, n, g);
      const chars = [...text];
      const widths = chars.map((c) => (GLYPH[c] || FONT3[c] || FONT3[' '])[0].length);
      const total = widths.reduce((a, b) => a + b + 1, -1);
      let cx = x + Math.floor((w - total) / 2);
      chars.forEach((c, i) => {
        const gh = GLYPH[c] ? GLYPH[c].length : 5;
        this.glyph(c, cx, y + Math.floor((h - gh) / 2), (px, py) => {
          if (mode === 'lit') this.px(px, py, M.PAINT_K);
          else this.tube(px, py, off, n, g);
        });
        cx += widths[i] + 1;
      });
    }
    wire(x0, y0, x1, y1, sag, m = M.WIRE) {
      const steps = Math.abs(x1 - x0);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const y = Math.round(mix(y0, y1, t) + sag * 4 * t * (1 - t));
        this.px(x0 + i * Math.sign(x1 - x0), y, m);
      }
    }
    wireY(x0, y0, x1, y1, sag, x) {
      const t = (x - x0) / (x1 - x0);
      return Math.round(mix(y0, y1, t) + sag * 4 * t * (1 - t));
    }

    // ---- Sky lookup, one pair of stops per row and key
    buildSky() {
      this.skyLo = SKY.map(() => new Uint32Array(BH));
      this.skyHi = SKY.map(() => new Uint32Array(BH));
      this.skyF = new Uint8Array(BH);
      for (let y = 0; y < BH; y++) {
        const p = clamp(Math.pow(y / SKY_END, 1.25)) * 3.999;
        const lo = Math.floor(p);
        this.skyF[y] = Math.round((p - lo) * 16);
        SKY.forEach((stops, key) => {
          this.skyLo[key][y] = stops[lo];
          this.skyHi[key][y] = stops[lo + 1];
        });
      }
    }

    // ---- Everything that doesn't move
    buildStatic() {
      const r = rng(1984);
      this.neonGroup = this.addGroup(18.2, 28.4);
      this.towerGroup = this.addGroup(17.9, 28.2, 'neon', { soft: true });
      this.towerHot = this.addGroup(18.1, 28.0, 'neon', { soft: true });
      this.tubeL = this.addGroup(18.25, 28.6);
      this.tubeR = this.addGroup(18.45, 28.5);
      this.lanternGroup = this.addGroup(16.5, 27.6, 'neon', { soft: true });
      this.store = this.addGroup(12, 40, 'room');
      this.farWin = [];
      for (let i = 0; i < 5; i++) this.farWin.push(this.addGroup(18 + i * 0.3, 25 + i * 0.7, 'room'));
      this.winGroups = [];
      for (let i = 0; i < 28; i++) {
        this.winGroups.push(this.addGroup(17.6 + r() * 2, 23.5 + r() * 5.2, 'room'));
      }

      // Stars
      for (let i = 0; i < 26; i++) this.stars.push([Math.floor(r() * BW) - PAD_X, Math.floor(r() * 60) - PAD_Y, r() * 6.28]);

      this.drawFuji();
      this.drawFarCity(r);
      this.drawTower();
      this.drawNearCity(r);
      this.depth = 1;
      this.drawViaduct();
      this.depth = 2;
      this.drawLeftBlock(r);
      this.drawRightBlock(r);
      this.drawEdges();
      this.drawStreet();
      this.drawPoles();
      this.depth = 0;
    }

    drawFuji() {
      const peak = 130;
      const top = 54;
      for (let y = top; y < 108; y++) {
        const d = y - top;
        const hw = Math.pow(d, 1.1) * 1.32 + 1;
        for (let x = Math.floor(peak - hw); x <= peak + hw; x++) {
          const ridge = Math.sin(x * 0.42) * 2 + Math.sin(x * 0.17 + 1) * 1.6;
          const snow = d < 11 + ridge;
          const rib = (x - peak) * 0.28 + d * 0.3;
          this.px(x, y, snow ? M.SNOW : Math.sin(rib) > 0.72 ? M.FUJI_DK : M.FUJI);
        }
      }
    }

    drawFarCity(r) {
      // Back row: low in the middle so Fuji and the tower read
      for (let x = -PAD_X; x < 360; ) {
        const w = 7 + Math.floor(r() * 13);
        const mid = Math.abs(x + w / 2 - 150) < 42 ? 0.3 : 1;
        const h = Math.round((12 + r() * 34) * mid);
        this.rect(x, 104 - h, w, h + 10, M.FAR1);
        x += w + (r() < 0.2 ? 2 : 0);
      }
      // Two tall towers, west of the rail gap, with aviation lights
      this.tallTower(98, 58, 12, M.FAR2);
      this.tallTower(187, 50, 11, M.FAR2);
      this.tallTower(199, 62, 9, M.FAR1);
      for (let x = -PAD_X; x < 360; ) {
        const w = 6 + Math.floor(r() * 10);
        const mid = Math.abs(x + w / 2 - 150) < 40 ? 0.4 : 1;
        const h = Math.round((8 + r() * 22) * mid);
        this.rect(x, 108 - h, w, h + 8, M.FAR2);
        const g = this.farWin[Math.floor(r() * 5)];
        for (let wy = 110 - h; wy < 106; wy += 3) {
          for (let wx = x + 1; wx < x + w - 1; wx += 2) {
            if (r() < 0.32) this.light(wx, wy, N.WARM_DIM, g);
          }
        }
        x += w;
      }
    }

    tallTower(x, top, w, m) {
      this.rect(x, top, w, 110 - top, m);
      this.rect(x + 2, top - 3, w - 4, 3, m);
      this.rect(x + Math.floor(w / 2), top - 9, 1, 6, m);
      this.beacons.push([x + Math.floor(w / 2), top - 9]);
      const g = this.farWin[Math.floor(x % 5)];
      for (let wy = top + 1; wy < 106; wy += 2) {
        for (let wx = x + 1; wx < x + w - 1; wx += 1) {
          if ((wx * 7 + wy * 13) % 5 < 2) this.light(wx, wy, N.WARM_DIM, g);
        }
      }
    }

    // Lattice tower: splayed legs, main deck, upper deck, antenna
    drawTower() {
      const cx = 171;
      const top = 30;
      const base = 104;
      const put = (x, y, band) => {
        this.px(x, y, band ? M.TOWER_R : M.TOWER_W);
        this.light(x, y, y > 68 ? N.TOWER : N.TOWER_HOT, y > 68 ? this.towerGroup : this.towerHot);
      };
      for (let y = top; y <= base; y++) {
        const d = y - top;
        const band = Math.floor(d / 5) % 2 === 0;
        let hw;
        if (y < 44) hw = 0;
        else if (y < 53) hw = 1;
        else if (y < 80) hw = 1 + Math.pow((y - 53) / 27, 1.5) * 4.6;
        else hw = 5.6 + Math.pow((y - 80) / 24, 1.5) * 13;
        hw = Math.round(hw);
        for (let x = -hw; x <= hw; x++) {
          const edge = Math.abs(x) >= hw - (y > 88 ? 2 : 0);
          if (y > 88) {
            // Legs part into an arch
            if (edge) put(cx + x, y, band);
          } else if (edge || (x + y) % 2 === 0) put(cx + x, y, band);
        }
      }
      // Decks
      for (let x = -3; x <= 3; x++) for (let y = 53; y <= 55; y++) put(cx + x, y, true);
      for (let x = -8; x <= 8; x++) for (let y = 80; y <= 83; y++) put(cx + x, y, y === 80);
      for (let x = -7; x <= 7; x += 2) this.px(cx + x, 82, M.GLASS_DK), this.light(cx + x, 82, N.TOWER_HOT, this.towerHot);
      this.beacons.push([cx, top]);
    }

    drawNearCity(r) {
      // Mid row between the skyline and the rail: only seen in gaps
      for (let x = -PAD_X; x < 360; ) {
        const w = 10 + Math.floor(r() * 12);
        const mid = Math.abs(x + w / 2 - 150) < 44 ? 0.28 : 1;
        const h = Math.round((12 + r() * 24) * mid);
        this.rect(x, 112 - h, w, h + 6, M.FAR3);
        x += w;
      }
    }

    drawViaduct() {
      const deck = 90;
      this.rect(-PAD_X, deck, 400, 2, M.STEEL_LT);
      this.rect(-PAD_X, deck + 2, 400, 5, M.STEEL);
      this.rect(-PAD_X, deck + 7, 400, 1, M.STEEL_DK);
      for (let x = -PAD_X; x < 360; x += 8) {
        for (let i = 0; i < 4; i++) {
          this.px(x + i, deck + 2 + i, M.STEEL_DK);
          this.px(x + 7 - i, deck + 2 + i, M.STEEL_DK);
        }
        this.px(x, deck + 1, M.STEEL_DK);
      }
      // Piers and spans
      for (const x of [118, 160, 198]) {
        this.rect(x, deck + 8, 6, GROUND - deck - 8, M.CONC);
        this.rect(x, deck + 8, 1, GROUND - deck - 8, M.CONC_LT);
        this.rect(x + 5, deck + 8, 1, GROUND - deck - 8, M.CONC_DK);
        this.rect(x - 1, deck + 8, 8, 2, M.CONC_DK);
      }
      // Overhead line and masts
      for (const x of [112, 150, 192]) {
        this.rect(x, 70, 1, 20, M.STEEL_DK);
        this.rect(x - 2, 72, 5, 1, M.STEEL_DK);
      }
      for (let x = -PAD_X; x < 360; x++) this.px(x, 73, M.WIRE);

      this.drawYakitori();
      this.drawArch2();
    }

    // First arch: a yakitori bar tucked under the tracks. Shutter down by day (see drawDynamicShops).
    drawYakitori() {
      const x0 = 124;
      const w = 36;
      this.rect(x0, 98, w, 20, M.WOOD_DK);
      this.rect(x0, 98, w, 4, M.BOARD_K);
      this.hsign(x0 + 8, 98, 20, 4, '', { n: N.B_RED, g: this.lanternGroup, board: M.BOARD_R, mode: 'lit' });
      this.rect(x0, 102, w, 9, M.ROOM);
      this.lightRect(x0, 102, w, 9, N.WARM, this.lanternGroup);
      // Bottles along the back
      for (let i = 2; i < w - 2; i += 3) {
        const c = [M.BOARD_G, M.GLASS_HI, M.BOARD_O][i % 3];
        this.rect(x0 + i, 104, 1, 2, c);
      }
      this.rect(x0, 106, w, 1, M.WOOD_LT);
      // Counter
      this.rect(x0, 110, w, 2, M.WOOD_LT);
      this.rect(x0, 112, w, 6, M.WOOD);
      for (let i = 1; i < w; i += 4) this.rect(x0 + i, 112, 1, 6, M.WOOD_DK);
      // Crates
      this.rect(x0 + 1, 113, 6, 5, M.CRATE);
      this.rect(x0 + 1, 115, 6, 1, M.BOARD_R);
      this.rect(x0 + 2, 112, 1, 1, M.GLASS_DK);
      this.rect(x0 + 4, 112, 1, 1, M.GLASS_DK);
      this.lanternsAt = [];
      for (let i = 0; i < 6; i++) this.lanternsAt.push(x0 + 3 + i * 6);
    }

    // Second arch: vending machines and a poster wall
    drawArch2() {
      const x0 = 166;
      this.rect(x0, 98, 32, 20, M.CONC_DK);
      this.rect(x0, 98, 32, 3, M.SLATE_DK);
      this.rect(x0 + 20, 103, 4, 7, M.POSTER_A);
      this.rect(x0 + 25, 103, 4, 7, M.POSTER_B);
      this.rect(x0 + 21, 105, 2, 1, M.BOARD_W);
      this.rect(x0 + 26, 106, 2, 1, M.BOARD_W);
      this.rect(x0 + 20, 113, 9, 5, M.SHUTTER);
      this.vending(x0 + 1, 101, M.VEND_R, 0);
      this.vending(x0 + 10, 101, M.VEND_B, 1);
      // Station clock hanging under the deck, drawn live
      this.clockAt = [x0 + 5, 92];
      this.rect(x0 + 3, 91, 23, 7, M.BOARD_K);
    }

    vending(x, y, body, seed) {
      const w = 8;
      const h = GROUND - y;
      this.rect(x, y, w, h, body);
      this.rect(x + 1, y + 1, w - 2, 7, M.VEND_W);
      this.lightRect(x + 1, y + 1, w - 2, 7, N.STORE, this.store);
      const colors = [M.BOARD_R, M.BOARD_B, M.BOARD_Y, M.BOARD_G, M.BOARD_O, M.BOARD_W];
      for (let row = 0; row < 2; row++) {
        for (let i = 0; i < 3; i++) {
          const m = colors[(i * 2 + row * 3 + seed * 5) % colors.length];
          this.rect(x + 1 + i * 2, y + 2 + row * 3, 1, 2, m);
        }
      }
      this.rect(x + 1, y + 10, 4, 2, M.VEND_DK);
      this.rect(x + 6, y + 9, 1, 3, M.VEND_DK);
      this.rect(x + 1, y + 13, w - 2, 2, M.VEND_DK);
      this.rect(x + w - 1, y, 1, h, M.VEND_DK);
    }

    // ---- Left block: apartment, old ramen shop, sakura
    drawLeftBlock(r) {
      // Apartment with balconies
      const ax = 14;
      const aw = 64;
      const atop = 36;
      this.rect(ax, atop, aw, GROUND - atop, M.TILE);
      this.rect(ax + aw - 3, atop, 3, GROUND - atop, M.TILE_DK);
      this.rect(ax, atop, aw, 2, M.TILE_LT);
      this.rect(ax + 12, atop - 8, 10, 8, M.TANK);
      this.rect(ax + 12, atop - 8, 10, 1, M.TANK_DK);
      this.rect(ax + 12, atop - 2, 10, 2, M.TANK_DK);
      this.rect(ax + 34, atop - 13, 1, 13, M.STEEL_DK);
      this.rect(ax + 32, atop - 11, 5, 1, M.STEEL_DK);
      this.rect(ax + 31, atop - 8, 7, 1, M.STEEL_DK);
      this.balconies = [];
      for (let f = 0; f < 5; f++) {
        const y = atop + 4 + f * 15;
        for (let u = 0; u < 3; u++) {
          const x = ax + 3 + u * 20;
          const g = this.winGroups[(f * 3 + u * 5) % this.winGroups.length];
          this.rect(x, y, 18, 10, M.TILE_DK);
          this.rect(x + 1, y + 1, 7, 8, M.GLASS);
          this.rect(x + 9, y + 1, 7, 8, M.GLASS);
          this.rect(x + 1, y + 1, 7, 2, M.GLASS_HI);
          if ((f + u) % 2 === 0) {
            this.lightRect(x + 1, y + 1, 7, 8, N.WARM, g);
            this.lightRect(x + 9, y + 1, 7, 8, N.WARM, g);
          } else if ((f * u) % 3 === 1) {
            this.lightRect(x + 1, y + 1, 7, 8, N.FLUO, g);
          }
          // Balcony rail
          this.rect(x - 1, y + 10, 20, 1, M.RAIL_B);
          for (let i = 0; i < 20; i += 2) this.rect(x - 1 + i, y + 7, 1, 3, M.RAIL_B);
          this.rect(x - 1, y + 6, 20, 1, M.CREAM);
          this.rect(x + 14, y + 8, 3, 2, M.AC);
          this.balconies.push([x, y, f, u]);
        }
      }

      // Small grey office behind the shop, with a billboard
      this.rect(78, 58, 40, 60, M.GREY);
      this.rect(78, 58, 40, 2, M.ROOF);
      this.rect(114, 58, 4, 60, M.GREY_DK);
      for (let f = 0; f < 3; f++) {
        for (let i = 0; i < 4; i++) {
          const x = 81 + i * 8;
          const y = 62 + f * 8;
          this.rect(x, y, 6, 5, M.GLASS);
          this.rect(x, y, 6, 1, M.GLASS_HI);
          if ((f * 5 + i * 3) % 4 !== 1) this.lightRect(x, y, 6, 5, i % 2 ? N.FLUO : N.WARM, this.winGroups[(f + i * 7) % this.winGroups.length]);
          this.rect(x + 3, y, 1, 5, M.GLASS_DK);
        }
      }
      for (let x = 86; x < 110; x += 5) this.rect(x, 39, 1, 19, M.STEEL_DK);
      this.rect(85, 46, 26, 1, M.STEEL_DK);
      this.hsign(84, 29, 28, 11, 'RAMEN', { n: N.YELLOW, g: this.neonGroup, board: M.BOARD_R, off: M.BOARD_Y });

      // Old shop: tiled roof, upper storey, noren and lanterns
      const sx = 70;
      const sw = 48;
      this.rect(sx, 92, sw, 26, M.PLASTER);
      for (let i = 0; i < 2; i++) this.rect(sx + 2 + i * 42, 92, 2, 26, M.WOOD_DK);
      for (let y = 82; y < 92; y++) {
        const inset = Math.round((92 - y) * 0.8);
        for (let x = sx - 4 + inset; x < sx + sw + 4 - inset; x++) {
          const tile = ((x + (y % 2) * 2) % 4 === 0);
          this.px(x, y, y === 82 ? M.KAWARA_HI : y % 3 === 2 ? M.KAWARA_DK : tile ? M.KAWARA_DK : M.KAWARA);
        }
      }
      this.rect(sx - 5, 91, sw + 10, 1, M.KAWARA_DK);
      // Upper window, wood lattice
      this.rect(sx + 12, 94, 24, 8, M.WOOD_DK);
      this.rect(sx + 13, 95, 22, 6, M.PLASTER);
      this.lightRect(sx + 13, 95, 22, 6, N.WARM, this.winGroups[3]);
      for (let x = sx + 13; x < sx + 35; x += 3) this.rect(x, 95, 1, 6, M.WOOD);
      this.rect(sx + 13, 97, 22, 1, M.WOOD);
      // Eave
      for (let x = sx - 3; x < sx + sw + 3; x++) {
        this.px(x, 104, (x % 3 === 0) ? M.KAWARA_DK : M.KAWARA);
        this.px(x, 105, M.KAWARA_DK);
      }
      // Front
      this.rect(sx + 4, 106, sw - 8, 12, M.WOOD);
      this.rect(sx + 6, 106, 36, 12, M.ROOM);
      this.lightRect(sx + 6, 106, 36, 12, N.WARM, this.lanternGroup);
      for (let x = sx + 6; x < sx + 42; x += 4) this.rect(x, 110, 1, 8, M.WOOD_DK);
      this.rect(sx + 6, 114, 36, 1, M.WOOD_DK);
      // Noren
      for (let i = 0; i < 5; i++) {
        const nx = sx + 9 + i * 6;
        this.rect(nx, 106, 5, 6, M.NOREN);
        this.px(nx + 2, 108, M.NOREN_W);
        this.px(nx + 1, 109, M.NOREN_W);
        this.px(nx + 3, 109, M.NOREN_W);
      }
      this.rect(sx + 8, 106, 32, 1, M.WOOD_DK);
      // Lanterns
      this.lantern(sx + 1, 106);
      this.lantern(sx + sw - 6, 106);
      // Vertical sign on the corner
      this.vsign(sx + sw - 1, 62, 'ラーメン', { n: N.B_YELLOW, g: this.neonGroup, board: M.BOARD_Y, mode: 'lit' });
      // Pot plants
      this.rect(sx + 44, 115, 3, 3, M.BRICK);
      this.rect(sx + 44, 112, 3, 3, M.BOARD_G);

      // Sakura
      this.depth = 3;
      const blobs = [[46, 66, 17], [28, 74, 13], [66, 72, 13], [40, 84, 12], [58, 86, 11], [20, 86, 8], [74, 84, 7]];
      const leaf = rng(44);
      for (let y = 46; y < 102; y++) {
        for (let x = 4; x < 90; x++) {
          let inside = false;
          let best = 9;
          for (const [bx, by, br] of blobs) {
            const dx = x - bx;
            const dy = (y - by) * 1.1;
            const dd = Math.hypot(dx, dy) / br;
            if (dd < 1) inside = true;
            best = Math.min(best, dd);
          }
          const n = leaf();
          if (!inside) {
            if (best < 1.08 && n < 0.35) this.px(x, y, M.SAK3);
            continue;
          }
          const shade = (y - 46) / 56 + (n - 0.5) * 0.55 - (0.62 - best) * 0.3;
          const m = shade < 0.2 ? M.SAK4 : shade < 0.5 ? M.SAK1 : shade < 0.8 ? M.SAK2 : M.SAK3;
          this.px(x, y, m);
        }
      }
      // Trunk and limbs
      this.rect(45, 94, 4, 24, M.BARK);
      this.rect(45, 94, 1, 24, M.BARK_LT);
      this.rect(44, 115, 6, 3, M.BARK);
      for (let i = 0; i < 12; i++) {
        this.rect(45 - i, 94 - Math.round(i * 0.6), 2, 2, M.BARK);
        this.rect(48 + i, 95 - Math.round(i * 0.55), 2, 2, M.BARK);
      }
      // Paper lanterns strung through the tree for yozakura
      const stringY = (x) => 91 + Math.round(Math.sin((x - 14) / 56 * Math.PI) * 4);
      for (let x = 14; x < 70; x++) this.px(x, stringY(x), M.WIRE);
      for (let x = 18; x < 70; x += 10) {
        const y = stringY(x) + 1;
        this.rect(x - 1, y, 3, 4, M.LANTERN);
        this.lightRect(x - 1, y, 3, 4, N.LANTERN_HOT, this.lanternGroup);
      }
      this.depth = 2;
    }

    lantern(x, y) {
      this.rect(x + 1, y, 3, 1, M.PAINT_K);
      this.rect(x, y + 1, 5, 6, M.LANTERN);
      this.rect(x, y + 6, 5, 1, M.LANTERN_DK);
      this.rect(x + 1, y + 7, 3, 1, M.PAINT_K);
      this.lightRect(x, y + 1, 5, 6, N.LANTERN, this.lanternGroup);
      this.lightRect(x + 1, y + 2, 3, 3, N.LANTERN_HOT, this.lanternGroup);
    }

    // ---- Right block: multi-tenant towers, stacked with signs
    drawRightBlock(r) {
      const g = () => this.addGroup(18.15 + r() * 1.1, 27.4 + r() * 1.4);
      this.bigSign = g();
      this.brokenSign = this.addGroup(18.8, 28.2, 'neon', { broken: true });

      const tower = (x, w, top, wall, dk, floors = 12) => {
        this.rect(x, top, w, GROUND - top, wall);
        this.rect(x + w - 2, top, 2, GROUND - top, dk);
        this.rect(x, top, w, 1, dk);
        for (let y = top + 3; y < GROUND - 14; y += floors) {
          this.rect(x, y + floors - 2, w, 1, dk);
          for (let wx = x + 2; wx < x + w - 5; wx += 7) {
            const lit = [N.WARM, N.ROOM_P, N.FLUO, N.ROOM_C, N.WARM, N.FLUO][(wx + y) % 6];
            this.rect(wx, y + 1, 5, 6, M.GLASS);
            this.rect(wx, y + 1, 5, 1, M.GLASS_HI);
            if ((wx * 13 + y * 7) % 5 > 1) this.lightRect(wx, y + 1, 5, 6, lit, this.winGroups[(wx * 3 + y) % this.winGroups.length]);
            this.rect(wx + 2, y + 1, 1, 6, M.GLASS_DK);
            this.rect(wx, y + 7, 5, 1, dk);
          }
        }
      };

      // Three narrow towers
      tower(204, 28, 38, M.SLATE, M.SLATE_DK);
      tower(232, 38, 28, M.INK, M.INK_DK);
      tower(270, 34, 46, M.BRICK, M.BRICK_DK);

      // Roof kit
      this.rect(208, 30, 10, 8, M.TANK);
      this.rect(208, 30, 10, 1, M.TANK_DK);
      this.rect(208, 36, 10, 2, M.TANK_DK);
      this.rect(222, 26, 1, 12, M.STEEL_DK);
      this.rect(220, 28, 5, 1, M.STEEL_DK);
      this.rect(282, 38, 12, 8, M.AC);
      this.rect(282, 38, 12, 1, M.AC_DK);
      for (let i = 284; i < 292; i += 2) this.rect(i, 40, 1, 4, M.AC_DK);

      // Rooftop neon: scaffold plus big letters
      this.rect(232, 8, 38, 20, M.STEEL_DK);
      this.rect(234, 9, 34, 17, M.BOARD_K);
      for (let x = 234; x < 270; x += 6) this.rect(x, 24, 1, 4, M.STEEL);
      const big = (rows, ox, n) => {
        rows.forEach((row, j) => {
          for (let i = 0; i < row.length; i++) if (row[i] === '#') this.tube(ox + i, 11 + j, M.TUBE, n, this.bigSign);
        });
      };
      big(ROOF_TO, 236, N.CYAN);
      big(ROOF_KYO, 253, N.PINK);

      // Vertical signs, overlapping like the real thing
      this.vsign(201, 44, 'カラオケ', { n: N.PINK, g: g(), w: 9 });
      this.vsign(201, 78, '酒', { n: N.B_RED, g: g(), board: M.BOARD_R, mode: 'lit', w: 11 });
      this.vsign(226, 44, 'スナック', { n: N.YELLOW, g: this.brokenSign, w: 9, off: M.BOARD_Y });
      this.vsign(263, 34, 'ホテル', { n: N.VIOLET, g: g(), w: 9, off: M.BOARD_V });
      this.vsign(263, 64, 'バー', { n: N.CYAN, g: g(), w: 9 });
      this.vsign(298, 54, '湯', { n: N.B_BLUE, g: g(), board: M.BOARD_B, mode: 'lit', w: 11 });

      // Horizontal boards stepping down the middle tower
      this.hsign(236, 40, 25, 9, 'NIGHT', { n: N.B_PINK, g: g(), board: M.BOARD_P, mode: 'lit' });
      this.hsign(236, 50, 25, 9, 'SNACK', { n: N.B_YELLOW, g: g(), board: M.BOARD_Y, mode: 'lit' });
      // LED ticker, drawn live
      this.tickerAt = [236, 60, 25];
      this.rect(235, 59, 27, 9, M.BOARD_K);
      this.hsign(236, 69, 12, 9, '肉', { n: N.RED, g: g(), board: M.BOARD_K });
      this.hsign(249, 69, 12, 9, '夜', { n: N.GREEN, g: g(), board: M.BOARD_K });

      // Neon lucky cat on the brick tower, the paw is drawn live
      this.rect(274, 58, 26, 22, M.BOARD_K);
      this.neonCatAt = [278, 60];
      this.catGroup = g();
      const CAT = [
        '#.......#.....',
        '##.....##.....',
        '#.#####.#.....',
        '#.......#.....',
        '#.#...#.#.....',
        '#...#...#.....',
        '#..###..#.....',
        '.#.....#......',
        '#.......#.....',
        '#.......#.....',
        '#..###..#.....',
        '#.......#.....',
        '#########.....',
      ];
      CAT.forEach((row, j) => {
        for (let i = 0; i < row.length; i++) {
          if (row[i] === '#') this.tube(278 + i, 61 + j, M.TUBE, N.PINK, this.catGroup);
        }
      });
      this.hsign(274, 82, 26, 9, 'HOTEL', { n: N.B_WHITE, g: g(), board: M.BOARD_W, mode: 'lit' });

      // Ground floors
      this.drawKonbini();
      this.drawRamenBar(g);
      this.drawArcade(g);
    }

    // Corner store, bright and always open
    drawKonbini() {
      const x = 204;
      const w = 28;
      const y = 100;
      this.rect(x, y, w, 18, M.CREAM);
      this.rect(x, y, w, 5, M.BOARD_W);
      this.lightRect(x, y, w, 5, N.B_WHITE, this.store);
      this.rect(x, y + 1, w, 1, M.BOARD_G);
      this.lightRect(x, y + 1, w, 1, N.B_GREEN, this.store);
      this.rect(x, y + 3, w, 1, M.BOARD_B);
      this.lightRect(x, y + 3, w, 1, N.B_BLUE, this.store);
      this.rect(x + 1, y + 5, w - 2, 13, M.BOARD_W);
      this.lightRect(x + 1, y + 5, w - 2, 13, N.STORE, this.store);
      const colors = [M.BOARD_R, M.BOARD_Y, M.BOARD_G, M.BOARD_B, M.BOARD_O, M.BOARD_P];
      for (let row = 0; row < 3; row++) {
        for (let i = 0; i < 17; i++) {
          if ((i * 3 + row) % 4 === 3) continue;
          this.px(x + 2 + i, y + 7 + row * 3, colors[(i + row * 2) % colors.length]);
          this.px(x + 2 + i, y + 8 + row * 3, M.GREY);
        }
      }
      // Sliding door
      this.rect(x + 20, y + 5, 7, 13, M.GLASS_HI);
      this.lightRect(x + 20, y + 5, 7, 13, N.STORE, this.store);
      this.rect(x + 20, y + 5, 1, 13, M.STEEL_DK);
      this.rect(x + 23, y + 5, 1, 13, M.STEEL_DK);
      this.rect(x + 26, y + 5, 1, 13, M.STEEL_DK);
    }

    drawRamenBar(g) {
      const x = 232;
      const y = 80;
      this.rect(x, y, 38, 38, M.INK);
      // Bowl in neon tube
      const gg = g();
      this.rect(x + 3, y + 1, 32, 15, M.BOARD_K);
      const BOWL = [
        '..#..#..#.....#..',
        '..#..#..#....##..',
        '.#..#..#....#.#..',
        '.#..#..#...#..#..',
        '#################',
        '#...............#',
        '.#.............#.',
        '..#...........#..',
        '...###########...',
      ];
      BOWL.forEach((row, j) => {
        for (let i = 0; i < row.length; i++) {
          if (row[i] === '#') this.tube(x + 6 + i, y + 3 + j, M.TUBE, j < 4 ? N.CYAN : N.ORANGE, gg);
        }
      });
      this.rect(x + 25, y + 4, 1, 10, M.TUBE);
      this.lightRect(x + 25, y + 4, 1, 10, N.YELLOW, gg);
      this.rect(x + 28, y + 2, 1, 12, M.TUBE);
      this.lightRect(x + 28, y + 2, 1, 12, N.YELLOW, gg);
      // Awning
      for (let i = 0; i < 38; i++) {
        for (let j = 0; j < 3; j++) this.px(x + i, y + 17 + j, i % 4 < 2 ? M.BOARD_R : M.BOARD_W);
      }
      for (let i = 0; i < 38; i++) this.lightRect(x + i, y + 17, 1, 3, i % 4 < 2 ? N.B_RED : N.WARM, gg);
      // Interior
      this.rect(x + 2, y + 20, 34, 18, M.ROOM);
      this.lightRect(x + 2, y + 20, 34, 12, N.WARM, this.lanternGroup);
      this.rect(x + 2, y + 31, 34, 2, M.WOOD_LT);
      this.rect(x + 2, y + 33, 34, 5, M.WOOD);
      this.rect(x + 2, y + 25, 34, 1, M.WOOD_DK);
      for (let i = 0; i < 16; i++) this.rect(x + 3 + i * 2, y + 24 - (i % 3 === 0 ? 1 : 0), 1, 1 + (i % 3 === 0 ? 1 : 0), [M.BOARD_G, M.GLASS_DK, M.BOARD_O][i % 3]);
      // Regulars with their backs to the street
      for (const [px, c] of [[5, M.SUIT], [15, M.COAT], [27, M.SAILOR]]) {
        this.rect(x + px, y + 26, 3, 2, M.HAIR);
        this.rect(x + px - 1, y + 28, 5, 3, c);
        this.rect(x + px, y + 33, 3, 1, M.BOARD_R);
        this.rect(x + px + 1, y + 34, 1, 4, M.STEEL_DK);
      }
      // Steam-side bowls on the counter
      for (const px of [9, 21, 32]) this.rect(x + px, y + 30, 3, 1, M.BOARD_W);
      this.rect(x + 2, y + 20, 34, 1, M.WOOD_DK);
      for (let i = 0; i < 5; i++) {
        const nx = x + 3 + i * 7;
        this.rect(nx, y + 20, 6, 5, M.BOARD_R);
        this.px(nx + 2, y + 22, M.BOARD_W);
        this.px(nx + 3, y + 22, M.BOARD_W);
      }
    }

    // Game arcade with bulbs around its board, and two vending machines
    drawArcade(g) {
      const x = 270;
      const y = 92;
      this.rect(x, y, 34, 26, M.INK);
      this.rect(x + 2, y + 1, 30, 11, M.BOARD_K);
      this.hsign(x + 4, y + 3, 26, 7, 'ゲ－ム', { n: N.GREEN, g: g(), off: M.BOARD_G });
      this.bulbs = [];
      for (let i = 0; i < 30; i += 2) this.bulbs.push([x + 2 + i, y + 1], [x + 31 - i, y + 11]);
      for (let j = 2; j < 11; j += 2) this.bulbs.push([x + 31, y + j], [x + 2, y + 12 - j]);
      this.rect(x + 2, y + 13, 18, 13, M.ROOM);
      this.lightRect(x + 2, y + 13, 18, 13, N.ROOM_P, this.lanternGroup);
      for (let i = 0; i < 3; i++) {
        this.rect(x + 3 + i * 6, y + 15, 4, 8, M.INK_DK);
        this.rect(x + 3 + i * 6, y + 16, 4, 3, M.BOARD_B);
        this.lightRect(x + 3 + i * 6, y + 16, 4, 3, N.B_BLUE, this.lanternGroup);
      }
      this.vending(x + 21, 101, M.VEND_W, 2);
      this.vending(x + 30, 101, M.VEND_R, 3);
    }

    // Filler past the hero block, seen on wide windows
    drawEdges() {
      const near = (x, w, top, wall, dk) => {
        this.rect(x, top, w, GROUND - top, wall);
        this.rect(x + w - 2, top, 2, GROUND - top, dk);
        for (let y = top + 3; y < GROUND - 6; y += 9) {
          for (let wx = x + 2; wx < x + w - 5; wx += 6) {
            this.rect(wx, y, 4, 5, M.GLASS);
            this.rect(wx, y, 4, 1, M.GLASS_HI);
            if ((wx * 7 + y * 3) % 3 === 0) this.lightRect(wx, y, 4, 5, N.WARM, this.winGroups[(wx + y) % this.winGroups.length]);
          }
        }
      };
      near(-44, 24, 44, M.TEAL, M.TEAL_DK);
      near(-20, 34, 58, M.CREAM, M.CREAM_DK);
      near(304, 24, 40, M.TEAL, M.TEAL_DK);
      near(328, 36, 30, M.GREY, M.GREY_DK);
      const g = this.addGroup(18.4, 28);
      this.vsign(9, 62, 'カラオケ', { n: N.CYAN, g, w: 9 });
      this.vsign(-12, 70, '酒', { n: N.B_ORANGE, g, board: M.BOARD_O, mode: 'lit', w: 11 });
      this.vsign(306, 72, 'バー', { n: N.PINK, g, w: 9 });
      // Fronts
      this.rect(-20, 106, 34, 12, M.ROOM);
      this.lightRect(-20, 106, 34, 12, N.WARM, this.store);
      this.rect(-20, 106, 34, 2, M.BOARD_O);
      this.rect(304, 106, 58, 12, M.ROOM);
      this.lightRect(304, 106, 58, 12, N.FLUO, this.store);
      this.rect(304, 106, 58, 2, M.BOARD_B);
    }

    drawStreet() {
      // Sidewalk with tactile paving
      for (let y = GROUND; y < ROAD - 1; y++) {
        for (let x = -PAD_X; x < 360; x++) {
          const joint = x % 8 === (y % 4 < 2 ? 0 : 4) || y % 4 === 0;
          this.px(x, y, joint ? M.WALK_D : M.WALK);
        }
      }
      for (let x = -PAD_X; x < 360; x++) {
        const dot = (x + 1) % 3 === 0;
        this.px(x, GROUND + 2, M.WALK);
        this.px(x, GROUND + 3, dot ? M.WALK : M.TACTILE);
        this.px(x, GROUND + 4, M.WALK);
      }
      // Curb
      for (let x = -PAD_X; x < 360; x++) {
        this.px(x, ROAD - 1, M.CURB);
      }
      // Road
      const speck = rng(99);
      for (let y = ROAD; y < 150; y++) {
        for (let x = -PAD_X; x < 360; x++) {
          const n = speck();
          this.px(x, y, n < 0.06 ? M.ROAD_D : n > 0.94 ? M.ROAD_L : M.ROAD);
        }
      }
      // Lane dashes
      for (let x = -PAD_X; x < 360; x += 12) this.rect(x, 138, 6, 1, M.LINE);
      // Zebra crossing, sheared toward the viewer
      for (let y = ROAD + 1; y < 150; y += 3) {
        const shift = Math.round((y - ROAD) * 0.35);
        this.rect(148 - shift, y, 30 + shift * 2, 2, M.LINE);
      }
      // Stop lines
      this.rect(140 - 2, ROAD + 1, 2, 10, M.LINE);
      this.rect(190, 139, 2, 10, M.LINE);
      // Manholes and a drain
      this.rect(96, 144, 8, 2, M.MANHOLE);
      this.rect(232, 133, 7, 2, M.MANHOLE);
      for (let x = 60; x < 72; x += 2) this.px(x, ROAD, M.MANHOLE);
      // Speed limit painted on the road
      this.glyph('3', 262, 142, (x, y) => this.px(x, y, M.LINE));
      this.glyph('0', 266, 142, (x, y) => this.px(x, y, M.LINE));
    }

    drawPoles() {
      const poles = [[122, 40], [196, 34], [-16, 40], [318, 36]];
      for (const [x, top] of poles) {
        this.rect(x, top, 2, ROAD - 2 - top, M.POLE);
        this.rect(x + 1, top, 1, ROAD - 2 - top, M.POLE_DK);
        this.rect(x - 4, top + 4, 10, 1, M.POLE_DK);
        this.rect(x - 3, top + 8, 8, 1, M.POLE_DK);
        this.rect(x + 2, top + 10, 3, 6, M.TANK_DK);
        // Climbing pegs
        for (let y = top + 20; y < GROUND - 22; y += 5) this.px(x + (y % 2 ? 2 : -1), y, M.POLE_DK);
      }
      this.pole = poles;
      // Wires sag across the gap. Crows sit on the first.
      this.wireA = [122 - 3, 44, 196 - 3, 38, 7];
      this.wire(...this.wireA);
      this.wire(124, 44, 200, 38, 6);
      this.wire(-16, 44, 119, 44, 7);
      this.wire(-14, 48, 122, 48, 8);
      this.wire(198, 38, 204, 42, 1);
      this.wire(199, 42, 204, 46, 1);
      // Signal on its pole by the stop line
      this.rect(141, 104, 1, ROAD - 3 - 104, M.POLE);
      this.signalAt = [136, 100];
      this.rect(136, 100, 11, 5, M.BOARD_K);
      // Pedestrian signal
      this.rect(190, 108, 1, ROAD - 3 - 108, M.POLE);
      this.walkAt = [188, 102];
      this.rect(188, 102, 5, 7, M.BOARD_K);
    }

    // ---- Moving parts
    buildActors() {
      const r = rng(2024);
      this.rand = r;
      this.train = { x: -160, dir: 1, wait: 1.5 };
      this.cars = [
        { x: 30, lane: 0, dir: 1, kind: 'taxi', len: 25, speed: 44 },
        { x: 210, lane: 0, dir: 1, kind: 'kei', len: 19, speed: 38 },
        { x: 120, lane: 1, dir: -1, kind: 'sedan', len: 25, speed: 46, color: M.CAR_W },
        { x: 300, lane: 1, dir: -1, kind: 'taxi', len: 25, speed: 40 },
      ];
      this.signal = { t: 0 };
      this.peds = [];
      const styles = ['suit', 'suit', 'sailor', 'coat', 'randoseru', 'suit', 'coat'];
      for (let i = 0; i < 9; i++) {
        this.peds.push({
          x: -30 + r() * 380,
          y: GROUND + 4 + Math.floor(r() * 4),
          dir: r() < 0.5 ? 1 : -1,
          speed: 8 + r() * 6,
          style: styles[i % styles.length],
          phase: r() * 6,
          nightOnly: i > 5,
        });
      }
      this.crows = [];
      for (let i = 0; i < 4; i++) this.crows.push({ at: 132 + i * 13 + Math.floor(r() * 5), hop: r() * 8, fly: 0, x: 0, y: 0 });
      this.cat = { x: 112, y: GROUND + 7, state: 'sit', puff: 0, jump: 0 };
      this.petals = [];
      for (let i = 0; i < 26; i++) this.petals.push({ x: r() * 120 - 10, y: 50 + r() * 76, s: r() * 6, v: 0.6 + r() * 0.8 });
      this.smoke = [];
      for (let i = 0; i < 16; i++) this.smoke.push({ x: 0, y: -99, life: 0, src: i % 2 });
      this.rainDrops = [];
      for (let i = 0; i < 110; i++) this.rainDrops.push({ x: r() * BW - PAD_X, y: r() * BH - PAD_Y, v: 150 + r() * 90, l: 2 + Math.floor(r() * 3) });
      this.ripples = [];
      for (let i = 0; i < 18; i++) this.ripples.push({ x: 0, y: 0, a: 0 });
      this.clouds = [
        { x: 40, y: 16, w: 30, v: 1.3 },
        { x: 210, y: 10, w: 42, v: 0.8 },
        { x: 120, y: 24, w: 22, v: 1.7 },
        { x: 300, y: 16, w: 26, v: 1.1 },
      ];
      this.startled = 0;
      this.plane = { x: -30 };

      // Ticker message as a bitmap strip
      const msg = ' WELCOME TO 東京  BAR OPEN 24H  ラーメン ';
      this.tickerRows = Array.from({ length: 7 }, () => []);
      let cx = 0;
      for (const ch of msg) {
        const rows = GLYPH[ch] || FONT3[ch] || FONT3[' '];
        const w = rows[0].length;
        const oy = rows.length >= 7 ? 0 : 1;
        for (let j = 0; j < 7; j++) {
          for (let i = 0; i < w + 1; i++) {
            const row = rows[j - oy];
            this.tickerRows[j][cx + i] = row && row[i] === '#' ? 1 : 0;
          }
        }
        cx += w + 1;
      }
      this.tickerW = cx;
    }

    startle() {
      this.startled = 6;
      for (const c of this.crows) {
        if (!c.fly) {
          c.fly = 0.001;
          c.x = c.at;
          c.y = this.wireY(...this.wireA.slice(0, 4), this.wireA[4], c.at) - 3;
          c.vx = (this.rand() - 0.3) * 60;
          c.vy = -18 - this.rand() * 22;
        }
      }
      this.cat.puff = 1.4;
    }

    // ---- One world step. hour is on the 12..36 clock.
    tick(dt, hour, opts = {}) {
      const calm = opts.calm;
      if (!calm) this.t += dt;
      this.hour = hour;
      const hurry = opts.hurry || 0;
      this.dark = smooth(17.6, 19.4, hour) * (1 - smooth(28.7, 30.2, hour));
      this.rain = smooth(18.9, 20.2, hour) * (1 - smooth(27.6, 29.2, hour));

      this.updateGroups(dt, hour, calm);
      this.fmat.set(this.smat);
      this.fneon.set(this.sneon);
      this.fgroup.set(this.sgroup);
      this.mat = this.fmat;
      this.neon = this.fneon;
      this.group = this.fgroup;

      const adt = calm ? 0 : dt;
      this.drawSkyObjects(adt, hour);
      this.drawTrain(adt);
      this.drawShops(hour);
      this.drawSignsLive();
      this.drawCrows(adt, hour);
      this.drawBalcony(hour);
      this.drawPetals(adt, hour, hurry);
      this.drawSmoke(adt, hour);
      const beams = this.drawTraffic(adt);
      this.drawPeople(adt, hour);
      this.drawCat(adt, hour);

      this.mat = this.smat;
      this.neon = this.sneon;
      this.group = this.sgroup;

      this.compose(hour);
      this.drawBeams(beams);
      this.reflect();
      this.drawRain(adt);
    }

    updateGroups(dt, hour, calm) {
      const gs = this.groups;
      const levels = this.levels;
      levels[2] = this.dark > 0.45 ? 1 : 0;
      for (let i = 3; i < gs.length; i++) {
        const g = gs[i];
        const want = hour >= g.on && hour < g.off;
        if (want !== g.want) {
          g.want = want;
          g.ign = 0;
        }
        g.ign += dt;
        if (calm) {
          g.level = want ? 1 : 0;
        } else if (!want) {
          g.level = Math.max(0, g.level - dt * (g.kind === 'room' ? 6 : 8));
        } else if (g.kind === 'room' || g.soft) {
          g.level = Math.min(1, g.level + dt * 7);
        } else {
          // Neon doesn't fade up, it stutters
          const s = g.ign / (0.6 + (g.seed % 1) * 0.5);
          if (s >= 1) g.level = 1;
          else {
            const steps = [1, 0, 0.7, 0, 0, 1, 0.15, 1, 0.5, 1, 0.8, 1];
            g.level = steps[Math.floor(s * steps.length)];
          }
        }
        let lv = g.level;
        if (g.broken && lv > 0 && !calm) {
          const f = Math.sin(this.t * 37 + g.seed) * Math.sin(this.t * 2.3 + g.seed * 3);
          if (f > 0.55) lv = 0.1;
          else if (Math.sin(this.t * 0.9) > 0.86 && Math.sin(this.t * 41) > -0.2) lv = 0;
        }
        levels[i] = lv;
      }
      this.tubeLevels = [levels[this.tubeL], levels[this.tubeR]];
    }

    drawSkyObjects(dt, hour) {
      const h = hour;
      // Sun: noon high over the gap, sets exactly on Fuji's summit (a real thing: Diamond Fuji)
      let sx = -999, sy = 0, low = 0;
      if (h <= 18.4) {
        const t = clamp((h - 12) / (17.9 - 12));
        sx = mix(150, 130, t);
        sy = mix(21, 53, t * t);
        low = smooth(15.6, 17.4, h);
      } else if (h >= 29.2) {
        const t = clamp((h - 29.2) / (36 - 29.2));
        sx = mix(300, 150, t);
        sy = mix(100, 21, Math.sqrt(t));
        low = 1 - smooth(30.2, 31.8, h);
      }
      if (sx > -999) {
        const R = low > 0.3 ? 6 : 5;
        const n = low > 0.3 ? N.SUN_LOW : N.SUN;
        const sxi = Math.round(sx);
        const syi = Math.round(sy);
        for (let y = -R; y <= R; y++) {
          for (let x = -R; x <= R; x++) {
            if (x * x + y * y > R * R + 2) continue;
            const bx = sxi + x + PAD_X;
            const by = syi + y + PAD_Y;
            if (bx < 0 || by < 0 || bx >= BW || by >= BH) continue;
            const i = by * BW + bx;
            if (this.smat[i] !== 0) continue;
            this.fneon[i] = n;
            this.fgroup[i] = 1;
          }
        }
      }
      // Sun touching the summit flares
      this.diamond = h > 17.2 && h < 17.95 ? 1 - Math.abs(h - 17.6) / 0.35 : 0;
      if (this.diamond > 0 && Math.abs(sy - 53) < 4) {
        for (let d = -9; d <= 9; d++) {
          if (Math.abs(d) > 2 && (d + Math.floor(this.t * 4)) % 2) continue;
          this.pxLight(130 + d, 54, N.SUN_LOW);
          this.pxLight(130, 54 + d, N.SUN_LOW);
        }
      }
      // Moon
      if (h > 18.4 && h < 29.6) {
        const t = (h - 18.4) / 11.2;
        const mx = Math.round(mix(104, 156, t));
        const my = Math.round(mix(34, 22, Math.sin(t * Math.PI)));
        for (let y = -6; y <= 6; y++) {
          for (let x = -6; x <= 6; x++) {
            const inside = x * x + y * y <= 37;
            const bite = (x - 3) * (x - 3) + (y + 1) * (y + 1) <= 26;
            if (!inside || bite) continue;
            const bx = mx + x + PAD_X;
            const by = my + y + PAD_Y;
            if (this.smat[by * BW + bx] !== 0) continue;
            this.fmat[by * BW + bx] = x + y < -5 ? M.MOON : M.MOON_DK;
            this.fneon[by * BW + bx] = N.MOON_GLOW;
            this.fgroup[by * BW + bx] = 2;
          }
        }
      }
      // Stars, few: it is Tokyo
      if (this.dark > 0.4) {
        for (const [x, y, p] of this.stars) {
          if (Math.sin(this.t * 1.3 + p) < -0.2) continue;
          const i = (y + PAD_Y) * BW + x + PAD_X;
          if (i >= 0 && i < this.fmat.length && this.smat[i] === 0) {
            this.fneon[i] = N.STAR;
            this.fgroup[i] = 2;
          }
        }
        // Night flight into Haneda
        this.plane.x += dt * 5;
        if (this.plane.x > 360) this.plane.x = -40;
        const px = Math.round(this.plane.x);
        const py = -18 + Math.round(px * 0.04);
        const blink = Math.sin(this.t * 5) > 0.5;
        this.pxLight(px, py, N.HEAD);
        if (blink) this.pxLight(px - 2, py, N.BEACON);
      }
      // Clouds
      for (const c of this.clouds) {
        c.x += c.v * dt;
        if (c.x > 370) c.x = -60;
        const cx = Math.round(c.x);
        const seed = c.w;
        for (let i = 0; i < c.w; i++) {
          const bump = Math.round(2 + Math.sin(i * 0.5 + seed) * 2 + Math.sin(i * 0.21 + seed * 2) * 2 + Math.min(i, c.w - i) * 0.18);
          for (let j = -bump; j <= 1; j++) {
            this.pxSky(cx + i, c.y + j, j > -1 ? M.CLOUD_SH : M.CLOUD);
          }
        }
      }
      // Beacons, in step, as the real ones are
      if (this.dark > 0.3) {
        const on = (this.t % 2.4) < 1.1;
        if (on) for (const [x, y] of this.beacons) this.pxLight(x, y, N.BEACON);
      }
    }

    pxLight(x, y, n, g = 1) {
      const bx = x + PAD_X;
      const by = y + PAD_Y;
      if (bx < 0 || by < 0 || bx >= BW || by >= BH) return;
      const i = by * BW + bx;
      this.fneon[i] = n;
      this.fgroup[i] = g;
    }

    drawTrain(dt) {
      const tr = this.train;
      const carW = 40;
      const cars = 5;
      if (tr.wait > 0) {
        tr.wait -= dt;
        return;
      }
      tr.x += tr.dir * 86 * dt;
      const total = cars * (carW + 2);
      if ((tr.dir > 0 && tr.x > 370) || (tr.dir < 0 && tr.x + total < -50)) {
        tr.dir = -tr.dir;
        tr.x = tr.dir > 0 ? -total - 50 : 370;
        tr.wait = 5 + this.rand() * 7;
        return;
      }
      const lit = this.dark > 0.3;
      const base = Math.round(tr.x);
      const top = 77;
      const bob = Math.sin(this.t * 22) > 0.8 ? 1 : 0;
      for (let c = 0; c < cars; c++) {
        const cx = base + c * (carW + 2);
        if (cx > 370 || cx + carW < -50) continue;
        for (let i = 0; i < carW; i++) {
          const x = cx + i;
          const tip = c === (tr.dir > 0 ? cars - 1 : 0) ? (tr.dir > 0 ? carW - 1 - i : i) : 9;
          for (let y = 0; y < 13; y++) {
            let m = M.TRAIN;
            if (y === 0) m = M.TRAIN_ROOF;
            else if (y === 7 || y === 8) m = M.TRAIN_STRIPE;
            else if (y >= 11) m = M.TRAIN_UNDER;
            else if (y === 10) m = M.TRAIN_DK;
            if (tip < 2 && y < 2) continue;
            let n = 0, g = 0;
            const inWindow = y >= 2 && y <= 5;
            const door = i % 13 >= 10 ? 1 : 0;
            if (inWindow && (i % 13 !== 9) && i > 2 && i < carW - 3) {
              m = M.TRAIN_GLASS;
              // Passengers against the light
              const seat = ((i + c * 7) * 2654435761) >>> 28;
              if (lit) {
                n = N.FLUO;
                g = 2;
                if (y >= 3 && seat < 5 && !door) {
                  m = M.HAIR;
                  n = 0;
                  g = 0;
                }
              }
            }
            this.pxBehind(x, top + y + bob, m, n, g);
          }
        }
        // Bogies
        for (const b of [5, 31]) {
          this.pxBehind(cx + b, top + 12 + bob, M.TIRE);
          this.pxBehind(cx + b + 3, top + 12 + bob, M.TIRE);
        }
        // Pantograph up to the overhead line, sparks after dark
        if (c % 2 === 1) {
          const pm = cx + 20;
          for (let d = 0; d < 3; d++) {
            this.pxBehind(pm - d, top - 1 - d, M.STEEL_DK);
            this.pxBehind(pm + d - 3, top - 1 - d, M.STEEL_DK);
          }
          this.pxBehind(pm - 3, 74, M.STEEL_DK);
          this.pxBehind(pm - 2, 74, M.STEEL_DK);
          this.pxBehind(pm - 1, 74, M.STEEL_DK);
          if (lit && this.rand() < 0.04) {
            this.pxBehind(pm - 2, 73, M.WIRE, N.SPARK, 1);
            this.pxBehind(pm - 1, 72, M.WIRE, N.SPARK, 1);
          }
        }
      }
    }

    // Things that open and close with the hour
    drawShops(hour) {
      // Yakitori bar shutter: open 16:00 until 03:30
      const open = hour >= 16 && hour < 27.5;
      const x0 = 124;
      if (!open) {
        for (let y = 102; y < 118; y++) {
          for (let x = x0; x < x0 + 36; x++) {
            this.px(x, y, y % 2 ? M.SHUTTER : M.SHUTTER_DK);
          }
        }
        this.rect(x0 + 16, 116, 4, 1, M.STEEL_DK);
      } else {
        // Noren and lanterns
        for (let i = 0; i < 6; i++) {
          const nx = x0 + 2 + i * 6;
          if (i === 2 || i === 3) continue;
          this.rect(nx, 102, 5, 3, M.NOREN);
          this.px(nx + 2, 103, M.NOREN_W);
        }
        const sway = Math.sin(this.t * 1.7);
        this.lanternsAt.forEach((lx, i) => {
          const dx = Math.round(sway * 0.8 + Math.sin(i) * 0.3);
          this.rect(lx + dx - 1, 100, 3, 4, M.LANTERN);
          this.lightRect(lx + dx - 1, 100, 3, 4, N.LANTERN_HOT, this.lanternGroup);
        });
        // The master fans the grill, regulars lean in once it's dark
        const fan = Math.sin(this.t * 7) > 0;
        const mx = x0 + 20;
        this.rect(mx, 104, 3, 3, M.SKIN);
        this.rect(mx, 103, 3, 1, M.NOREN_W);
        this.px(mx + 1, 105, M.HAIR);
        this.rect(mx - 1, 107, 5, 3, M.NOREN_W);
        this.px(mx + 4, fan ? 106 : 108, M.SKIN);
        this.px(mx + 5, fan ? 105 : 108, M.BOARD_O);
        if (this.dark > 0.4) {
          // Grill coals
          for (let i = 0; i < 7; i++) this.pxLight(mx + 2 + i, 109, N.EMBER, 2);
          for (const [sx, c] of [[x0 + 8, M.SUIT], [x0 + 14, M.COAT]]) {
            this.rect(sx, 106, 3, 3, M.HAIR);
            this.rect(sx - 1, 109, 5, 5, c);
            this.rect(sx - 1, 114, 1, 4, M.STEEL_DK);
            this.rect(sx + 3, 114, 1, 4, M.STEEL_DK);
          }
        }
      }
    }

    drawSignsLive() {
      const dark = this.dark;
      const t = this.t;
      // Station clock
      if (this.clockAt) {
        const hh = Math.floor(((this.hour % 24) + 24) % 24);
        const mm = Math.floor((this.hour % 1) * 60);
        const txt = `${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}`;
        let cx = this.clockAt[0] + 1;
        const blink = Math.sin(t * Math.PI) > -0.4;
        for (const ch of txt) {
          if (ch === ':' && !blink) {
            cx += 4;
            continue;
          }
          this.glyph(ch, cx, this.clockAt[1], (x, y) => this.pxLight(x, y, N.LED));
          cx += 4;
        }
      }
      // Scrolling LED
      const [tx, ty, tw] = this.tickerAt;
      const lv = this.levels[this.neonGroup];
      if (lv > 0.2) {
        const offset = Math.floor(t * 14);
        for (let j = 0; j < 7; j++) {
          for (let i = 0; i < tw; i++) {
            if (this.tickerRows[j][(i + offset) % this.tickerW]) this.pxLight(tx + i, ty + 1 + j, N.LED);
          }
        }
      }
      // Bulbs round the arcade board chase each other
      const chase = Math.floor(t * 9);
      if (this.levels[this.neonGroup] > 0.2) {
        this.bulbs.forEach(([x, y], i) => {
          if ((i + chase) % 3 === 0) this.pxLight(x, y, N.YELLOW);
        });
      }
      // Lucky cat paw beckons
      if (this.levels[this.catGroup] > 0.2) {
        const up = Math.sin(t * 3.4) > 0;
        const [ax, ay] = this.neonCatAt;
        const rows = up
          ? [[9, 1], [10, 0], [11, 0], [12, 1], [12, 2], [11, 3], [10, 3], [9, 4]]
          : [[9, 4], [10, 3], [11, 3], [12, 4], [12, 5], [11, 6], [10, 6], [9, 7]];
        for (const [i, j] of rows) this.pxLight(ax + i, ay + j, N.YELLOW);
      } else {
        // Painted unlit paw, so the sign still reads by day
        const [ax, ay] = this.neonCatAt;
        for (const [i, j] of [[9, 4], [10, 3], [11, 3], [12, 4], [12, 5], [11, 6], [10, 6], [9, 7]]) this.px(ax + i, ay + j, M.TUBE);
      }
      // Traffic lights
      const s = this.signalState();
      const [sx, sy] = this.signalAt;
      const lamps = [[0, N.SIG_BLUE, s === 'go'], [1, N.SIG_YELLOW, s === 'slow'], [2, N.SIG_RED, s === 'stop']];
      for (const [i, n, on] of lamps) {
        const lx = sx + 1 + i * 3;
        this.rect(lx, sy + 1, 2, 3, M.LAMP_OFF);
        if (on) this.lightRect(lx, sy + 1, 2, 3, n, 1);
      }
      const [wx, wy] = this.walkAt;
      this.rect(wx + 1, wy + 1, 3, 5, M.LAMP_OFF);
      if (s === 'stop') {
        const bl = this.signal.t % 8 > 6.5 ? Math.sin(t * 16) > 0 : true;
        if (bl) {
          this.pxLight(wx + 2, wy + 1, N.SIG_BLUE);
          this.pxLight(wx + 1, wy + 2, N.SIG_BLUE);
          this.pxLight(wx + 2, wy + 2, N.SIG_BLUE);
          this.pxLight(wx + 3, wy + 2, N.SIG_BLUE);
          this.pxLight(wx + 2, wy + 3, N.SIG_BLUE);
          this.pxLight(wx + 1, wy + 4 + (Math.floor(t * 4) % 2), N.SIG_BLUE);
          this.pxLight(wx + 3, wy + 5 - (Math.floor(t * 4) % 2), N.SIG_BLUE);
        }
      } else {
        for (let j = 1; j < 6; j++) this.pxLight(wx + 2, wy + j, N.SIG_RED);
        this.pxLight(wx + 1, wy + 3, N.SIG_RED);
        this.pxLight(wx + 3, wy + 3, N.SIG_RED);
      }
    }

    signalState() {
      const t = this.signal.t % 13;
      return t < 7 ? 'go' : t < 8.2 ? 'slow' : 'stop';
    }

    drawCrows(dt, hour) {
      const day = hour < 17.8 || hour > 29.5;
      for (const c of this.crows) {
        if (c.fly) {
          c.fly += dt;
          c.x += c.vx * dt;
          c.y += c.vy * dt;
          c.vy += 2 * dt;
          const flap = Math.sin(this.t * 22) > 0;
          this.px(Math.round(c.x), Math.round(c.y), M.CROW);
          this.px(Math.round(c.x) + 1, Math.round(c.y), M.CROW);
          this.px(Math.round(c.x) - 1, Math.round(c.y) + (flap ? -1 : 1), M.CROW);
          this.px(Math.round(c.x) + 2, Math.round(c.y) + (flap ? -1 : 1), M.CROW);
          if (c.fly > 6) c.fly = 0;
          continue;
        }
        if (!day) continue;
        c.hop += dt;
        const y = this.wireY(...this.wireA.slice(0, 4), this.wireA[4], c.at);
        const nod = Math.sin(c.hop * 0.8) > 0.92 ? 1 : 0;
        this.rect(c.at - 1, y - 3, 4, 2, M.CROW);
        this.px(c.at - 2, y - 2, M.CROW);
        this.px(c.at - 3, y - 1, M.CROW);
        this.rect(c.at + 2, y - 5 + nod, 2, 2, M.CROW);
        this.px(c.at + 4, y - 4 + nod, M.CROW);
        this.px(c.at, y - 1, M.CROW);
      }
    }

    // A resident on the third floor. Laundry by day, a smoke at night.
    drawBalcony(hour) {
      const day = hour < 17.2 || hour > 31.5;
      const wave = this.t * 2.2;
      for (const [x, y, f, u] of this.balconies) {
        if (day && (f + u) % 2 === 1 && f < 4) {
          // Pole and washing
          this.rectBack(x, y + 1, 17, 1, M.STEEL_DK);
          const kinds = f === 1 ? [M.FUTON, M.FUTON] : [M.SHIRT_B, M.SHIRT, M.SHIRT_P];
          let cx = x + 1;
          for (const m of kinds) {
            const sway = Math.round(Math.sin(wave + cx) * 0.6);
            const w = f === 1 ? 6 : 3;
            for (let j = 0; j < 4; j++) this.rectBack(cx + (j > 1 ? sway : 0), y + 2 + j, w, 1, m);
            cx += w + 1;
          }
        }
        if (day && f === 1 && u === 1) {
          // Futon over the rail
          this.rectBack(x + 2, y + 5, 12, 5, M.FUTON);
          this.rectBack(x + 2, y + 7, 12, 1, M.FUTON_B);
        }
      }
      // The resident
      const [rx, ry] = [this.balconies[1][0] + 8, this.balconies[1][1]];
      if (day) {
        const reach = Math.sin(this.t * 1.3) > 0;
        this.rect(rx + 1, ry + 1, 3, 2, M.HAIR);
        this.rect(rx + 1, ry + 3, 3, 1, M.SKIN);
        this.rect(rx, ry + 4, 5, 3, M.SHIRT_P);
        this.px(rx - 1, reach ? ry + 3 : ry + 5, M.SKIN);
      } else if (hour > 19 && hour < 27.5) {
        // Silhouette at the rail, cigarette glowing and fading
        this.rect(rx + 1, ry + 1, 3, 3, M.HAIR);
        this.rect(rx, ry + 4, 5, 3, M.HAIR);
        const drag = Math.sin(this.t * 0.8) > 0.6;
        this.pxLight(rx + 5, ry + 3, N.EMBER);
        if (drag) this.pxLight(rx + 5, ry + 2, N.EMBER);
      }
    }

    drawPetals(dt, hour, hurry) {
      if (hour > 30.5 || hour < 20) {
        for (const p of this.petals) {
          p.y += p.v * 6 * dt;
          p.x += (Math.sin(p.s + this.t) * 7 + 3 + hurry * 70) * dt;
          if (p.y > 126 || p.x > 180) {
            p.y = 50 + this.rand() * 20;
            p.x = 8 + this.rand() * 70;
          }
          this.px(Math.round(p.x), Math.round(p.y), M.PETAL);
        }
      }
    }

    drawSmoke(dt, hour) {
      const open = hour >= 16 && hour < 27.5;
      for (const s of this.smoke) {
        if (s.life <= 0) {
          if (!open || this.rand() > dt * 2.6) continue;
          s.life = 2 + this.rand() * 1.5;
          s.max = s.life;
          // Yakitori grill / ramen bar vent
          s.x = s.src ? 150 + this.rand() * 6 : 262 + this.rand() * 4;
          s.y = s.src ? 104 : 80;
          s.p = this.rand() * 6;
        }
        s.life -= dt;
        s.y -= dt * 7;
        s.x += Math.sin(this.t * 1.3 + s.p) * dt * 4;
        const a = s.life / s.max;
        if (a * 16 < BAYER[(Math.round(s.y) & 3) * 4 + (Math.round(s.x) & 3)]) continue;
        const x = Math.round(s.x);
        const y = Math.round(s.y);
        if (s.src && y < 98 && y > 90) continue;
        this.px(x, y, M.SMOKE);
        if (a > 0.5) this.px(x + 1, y, M.SMOKE);
      }
    }

    drawTraffic(dt) {
      this.signal.t += dt;
      const go = this.signalState() === 'go';
      const beams = [];
      const LANE = [ROAD + 9, ROAD + 20];
      for (const car of this.cars) {
        const lead = car.dir > 0 ? car.x + car.len : car.x;
        const line = car.dir > 0 ? 136 : 192;
        let want = car.speed;
        // Stop at the line on red
        if (!go) {
          const gap = (line - lead) * car.dir;
          if (gap > 0 && gap < 28) want = gap < 3 ? 0 : car.speed * (gap / 28);
        }
        // Queue behind whoever is ahead
        for (const other of this.cars) {
          if (other === car || other.dir !== car.dir) continue;
          const gap = car.dir > 0 ? other.x - lead : lead - (other.x + other.len);
          if (gap > 0 && gap < 12) want = Math.min(want, Math.max(0, (gap - 4) * 3));
        }
        car.v = mix(car.v ?? want, want, clamp(dt * 3));
        car.x += car.dir * car.v * dt;
        if (car.dir > 0 && car.x > 370) car.x = -70 - this.rand() * 40;
        if (car.dir < 0 && car.x + car.len < -50) car.x = 370 + this.rand() * 40;
      }
      // Far lane first
      for (const car of [...this.cars].sort((a, b) => a.lane - b.lane)) {
        const y = LANE[car.lane];
        this.drawCar(car, Math.round(car.x), y);
        if (this.dark > 0.3) beams.push([car.dir > 0 ? Math.round(car.x + car.len) : Math.round(car.x) - 1, y, car.dir]);
      }
      return beams;
    }

    drawCar(car, x, y) {
      const { kind, len, dir } = car;
      const body = kind === 'taxi' ? M.CAR_K : kind === 'kei' ? M.CAR_Y : car.color || M.CAR_W;
      const flip = dir < 0;
      const col = (i) => (flip ? x + len - 1 - i : x + i);
      // Contact shadow
      for (let i = 1; i < len - 1; i++) this.px(x + i, y + 1, M.ROAD_D);
      for (let i = 0; i < len; i++) {
        const cx = col(i);
        const nose = len - 1 - i;
        const tail = i;
        let top = y - 4;
        if (kind === 'kei') {
          // Kei truck: tall cab at the front, low flatbed
          top = i > 11 ? y - 10 : y - 5;
        } else if (i > 5 && i < len - 6) {
          top = y - 9;
        } else if (i > 3 && i < len - 4) {
          top = y - 6;
        }
        if (nose < 1 || tail < 1) top = y - 3;
        for (let cy = top; cy <= y - 1; cy++) {
          let m = body;
          if (cy === y - 1) m = M.CAR_DK;
          this.px(cx, cy, m);
        }
      }
      // Windows
      if (kind === 'kei') {
        for (let i = 13; i < len - 2; i++) for (let cy = y - 9; cy < y - 6; cy++) this.px(col(i), cy, M.CAR_GLASS);
        for (let i = 1; i < 11; i++) this.px(col(i), y - 6, M.CAR_DK);
      } else {
        for (let i = 7; i < len - 7; i++) {
          if (i === Math.floor(len / 2)) continue;
          for (let cy = y - 8; cy < y - 5; cy++) this.px(col(i), cy, M.CAR_GLASS);
        }
      }
      // Wheels
      for (const w of [4, len - 7]) {
        for (let i = 0; i < 4; i++) {
          this.px(col(w + i), y, M.TIRE);
          this.px(col(w + i), y - 1, M.TIRE);
        }
        this.px(col(w + 1), y - 1, M.CAR_W);
      }
      // Lights
      const nose = col(len - 1);
      const tail = col(0);
      this.px(nose, y - 3, M.CAR_W);
      this.px(tail, y - 3, M.CAR_R);
      if (this.dark > 0.3) {
        this.pxLight(nose, y - 3, N.HEAD);
        this.pxLight(nose, y - 2, N.HEAD);
        this.pxLight(tail, y - 3, N.TAIL);
        this.pxLight(tail, y - 2, N.TAIL);
      }
      if (kind === 'taxi') {
        // Yellow stripe and lit roof sign
        for (let i = 2; i < len - 2; i++) this.px(col(i), y - 4, M.CAR_Y);
        const mid = Math.floor(len / 2);
        for (let i = -1; i <= 1; i++) {
          this.px(col(mid + i), y - 10, M.BOARD_O);
          if (this.dark > 0.2) this.pxLight(col(mid + i), y - 10, N.ORANGE);
        }
      }
    }

    drawPeople(dt, hour) {
      const rainy = this.rain > 0.35;
      const sorted = [...this.peds].sort((a, b) => a.y - b.y);
      const quiet = hour > 26.5 && hour < 30;
      sorted.forEach((p, idx) => {
        p.x += p.dir * p.speed * dt;
        if (p.x > 370) p.x = -40;
        if (p.x < -40) p.x = 370;
        if (p.nightOnly && hour < 17.5) return;
        if (quiet && idx % 3) return;
        const x = Math.round(p.x);
        const y = p.y;
        const step = Math.floor((p.x * 0.5 + p.phase) % 2 + 2) % 2;
        const flip = p.dir < 0;
        const cols = {
          suit: [M.SUIT, M.SUIT, M.HAIR],
          sailor: [M.SAILOR, M.SKIRT, M.HAIR],
          coat: [M.COAT, M.SUIT, M.HAIR],
          randoseru: [M.SHIRT, M.SUIT, M.HAIR],
        }[p.style];
        const [top, leg, hair] = cols;
        // Shadow
        this.px(x, y + 1, M.WALK_D);
        this.px(x + 1, y + 1, M.WALK_D);
        this.px(x + 2, y + 1, M.WALK_D);
        // Legs
        if (step) {
          this.px(x, y, leg);
          this.px(x + 2, y, leg);
          this.px(x, y - 1, leg);
          this.px(x + 2, y - 1, leg);
        } else {
          this.px(x + 1, y, leg);
          this.px(x + 1, y - 1, leg);
        }
        this.rect(x, y - 2, 3, 1, leg);
        // Body
        this.rect(x, y - 6, 3, 4, top);
        if (p.style === 'suit') this.px(x + (flip ? 0 : 2), y - 6, M.SHIRT);
        // Head
        this.rect(x, y - 9, 3, 3, M.SKIN);
        this.rect(x, y - 9, 3, 1, hair);
        this.px(flip ? x + 2 : x, y - 8, hair);
        // Things
        if (p.style === 'randoseru') this.rect(flip ? x + 3 : x - 1, y - 6, 1, 3, M.RANDO);
        if (p.style === 'suit') this.px(flip ? x - 1 : x + 3, y - 3 + step, M.CAR_DK);
        if (rainy) {
          // Clear convenience-store umbrella
          const ux = x + 1;
          for (let i = -4; i <= 4; i++) {
            const uy = y - 11 - (Math.abs(i) < 2 ? 2 : Math.abs(i) < 4 ? 1 : 0);
            this.px(ux + i, uy, M.UMB);
            this.pxLight(ux + i, uy, N.STAR, 2);
          }
          this.px(ux, y - 14, M.SHIRT);
          this.px(ux, y - 10, M.STEEL_LT);
        }
      });
    }

    drawCat(dt, hour) {
      const cat = this.cat;
      const night = this.dark > 0.5;
      cat.puff = Math.max(0, cat.puff - dt);
      const hop = cat.puff > 1 ? Math.round(Math.sin((1.4 - cat.puff) / 0.4 * Math.PI) * 4) : 0;
      const x = cat.x;
      const y = cat.y - hop;
      const tail = Math.sin(this.t * 2.2) > 0 ? 0 : 1;
      const map = { C: M.CAT_W, O: M.CAT_O, K: M.CAT_K };
      if (!night && cat.puff === 0) {
        // Asleep in the sun, tail flicking
        this.sprite(['..........', '....OCC...', 'CCCOOCCO..', 'CCCCCCCCK.', 'KKCCCCCC..'], map, x - 2, y - 4);
        if (tail) this.px(x + 8, y - 2, M.CAT_K);
        // Zzz
        const z = Math.floor(this.t) % 3;
        if (z) this.glyphZ(x + 6 + z, y - 6 - z);
      } else {
        this.sprite(['O..O...', 'OCCO...', 'CCCC...', 'CCCC.K.', '.CCC.K.', '.CCCOK.', '.C.C...'], map, x, y - 6);
        // Eyes shine under the neon
        if (night) {
          this.pxLight(x + 1, y - 4, N.EYE);
          this.pxLight(x + 3, y - 4, N.EYE);
        } else {
          this.px(x + 1, y - 4, M.CAT_K);
          this.px(x + 3, y - 4, M.CAT_K);
        }
        if (tail) this.px(x + 6, y - 4, M.CAT_K);
        if (cat.puff > 0) {
          // Surprise
          this.rect(x + 2, y - 11, 1, 2, M.BOARD_R);
          this.px(x + 2, y - 8, M.BOARD_R);
        }
      }
    }

    glyphZ(x, y) {
      this.px(x, y, M.CAT_W);
      this.px(x + 1, y, M.CAT_W);
      this.px(x + 1, y + 1, M.CAT_W);
      this.px(x, y + 2, M.CAT_W);
      this.px(x + 1, y + 2, M.CAT_W);
    }

    // ---- Indexed world to RGBA + emissive
    compose(hour) {
      let a = 0;
      while (a < KEYS.length - 2 && hour >= KEYS[a + 1][0]) a++;
      const [h0, k0] = KEYS[a];
      const [h1, k1] = KEYS[a + 1];
      const b = clamp((hour - h0) / (h1 - h0)) * STEPS;
      const lo = Math.min(Math.floor(b), STEPS - 1);
      const blend = Math.round((b - lo) * 16);
      const pair = a * 16 + lo;
      if (pair !== this.pair) {
        this.pair = pair;
        const t0 = lo / STEPS;
        const t1 = (lo + 1) / STEPS;
        for (let m = 1; m < MATS.length; m++) {
          this.palA[m] = mixPacked(MATS[m][k0], MATS[m][k1], t0);
          this.palB[m] = mixPacked(MATS[m][k0], MATS[m][k1], t1);
        }
        for (let y = 0; y < BH; y++) {
          this.rowLoA[y] = mixPacked(this.skyLo[k0][y], this.skyLo[k1][y], t0);
          this.rowHiA[y] = mixPacked(this.skyHi[k0][y], this.skyHi[k1][y], t0);
          this.rowLoB[y] = mixPacked(this.skyLo[k0][y], this.skyLo[k1][y], t1);
          this.rowHiB[y] = mixPacked(this.skyHi[k0][y], this.skyHi[k1][y], t1);
        }
      }
      const { palA, palB, rowLoA: loA, rowHiA: hiA, rowLoB: loB, rowHiB: hiB } = this;
      const pix = this.pix;
      const emit = this.emit;
      emit.fill(0);
      const levels = this.levels;
      const fmat = this.fmat;
      const fgroup = this.fgroup;
      const fneon = this.fneon;
      const skyF = this.skyF;
      const em = 0.28 + 0.72 * this.dark;
      for (let y = 0, i = 0; y < BH; y++) {
        const yy = (y & 3) << 2;
        const f = skyF[y];
        for (let x = 0; x < BW; x++, i++) {
          const th = BAYER[yy | (x & 3)];
          const th2 = (th + 5) & 15;
          const m = fmat[i];
          let c;
          if (m === 0) {
            if (blend > th2) c = f > th ? hiB[y] : loB[y];
            else c = f > th ? hiA[y] : loA[y];
          } else {
            c = blend > th2 ? palB[m] : palA[m];
          }
          const g = fgroup[i];
          if (g !== 0) {
            const lv = levels[g];
            if (lv * 16 > th) {
              const nn = NEONS[fneon[i]];
              c = nn.core;
              const e = lv * em;
              const j = i * 4;
              emit[j] = nn.r * e;
              emit[j + 1] = nn.g * e;
              emit[j + 2] = nn.b * e;
              emit[j + 3] = 255;
            }
          }
          pix[i] = c;
        }
      }
    }

    // Headlight pools on the road
    drawBeams(beams) {
      if (this.dark < 0.3) return;
      const pix = this.rgba;
      for (const [bx, by, dir] of beams) {
        for (let d = 1; d < 34; d++) {
          const spread = 1 + Math.floor(d / 7);
          const a = (1 - d / 34) * 0.55 * this.dark;
          for (let s = -spread; s <= 1; s++) {
            const x = bx + dir * d + PAD_X;
            const y = by + s + PAD_Y;
            if (x < 0 || x >= BW || y < ROAD + PAD_Y || y >= BH) continue;
            if (a * 16 < BAYER[(y & 3) * 4 + (x & 3)]) continue;
            if (!STREET_MATS.has(this.fmat[y * BW + x])) continue;
            const j = (y * BW + x) * 4;
            pix[j] = Math.min(255, pix[j] + 54);
            pix[j + 1] = Math.min(255, pix[j + 1] + 50);
            pix[j + 2] = Math.min(255, pix[j + 2] + 40);
          }
        }
      }
    }

    // Wet asphalt: every emissive pixel above throws a long, broken streak on the road
    reflect() {
      const wet = smooth(18.2, 20, this.hour) * (1 - smooth(28.8, 30.4, this.hour));
      if (wet <= 0.01) return;
      const pix = this.rgba;
      const emit = this.emit;
      const roadTop = ROAD + PAD_Y;
      const walkTop = GROUND + PAD_Y;
      const tick = Math.floor(this.t * 9);
      const sh = this.shimmer;
      // What each column of the city throws down at the road
      const { colR, colG, colB } = this;
      colR.fill(0);
      colG.fill(0);
      colB.fill(0);
      for (let y = roadTop - 12; y >= Math.max(0, roadTop - 130); y--) {
        const w = 1 - (roadTop - y) / 170;
        for (let x = 0, j = y * BW * 4; x < BW; x++, j += 4) {
          if (emit[j + 3] === 0) continue;
          colR[x] += emit[j] * w;
          colG[x] += emit[j + 1] * w;
          colB[x] += emit[j + 2] * w;
        }
      }
      for (let y = roadTop; y < BH; y++) {
        const dy = y - roadTop;
        const atten = Math.pow(1 - dy / 30, 0.7) * wet;
        const amp = 0.5 + dy * 0.06;
        const yy = (y & 3) << 2;
        for (let x = 0; x < BW; x++) {
          if (!STREET_MATS.has(this.fmat[y * BW + x])) continue;
          const sx = clamp(x + Math.round(sh[(x * 3 + y * 11 + tick) & 1023] * amp * 0.5), 1, BW - 2);
          const k1 = 0.022;
          let r = (colR[sx - 1] + 2 * colR[sx] + colR[sx + 1]) * k1;
          let g = (colG[sx - 1] + 2 * colG[sx] + colG[sx + 1]) * k1;
          let b = (colB[sx - 1] + 2 * colB[sx] + colB[sx + 1]) * k1;
          // A squashed mirror on top keeps the shapes of the lowest signs
          const sy = Math.round(roadTop - 2 - dy * 1.5);
          if (sy >= 0) {
            const j = (sy * BW + sx) * 4;
            r += emit[j] * 0.8;
            g += emit[j + 1] * 0.8;
            b += emit[j + 2] * 0.8;
          }
          if (r + g + b < 5) continue;
          // Ripples break the streak into bands
          const ripple = 0.72 + sh[(x + y * 37 + (tick >> 1) * 5) & 1023] * 0.09;
          const a = atten * ripple * (0.86 + (BAYER[yy | (x & 3)] / 16) * 0.3);
          const i = (y * BW + x) * 4;
          pix[i] = Math.min(255, pix[i] + Math.min(r, 235) * a);
          pix[i + 1] = Math.min(255, pix[i + 1] + Math.min(g, 235) * a);
          pix[i + 2] = Math.min(255, pix[i + 2] + Math.min(b, 235) * a);
        }
      }
      // Pavement catches the shopfronts
      for (let y = walkTop; y < roadTop - 1; y++) {
        const dy = y - walkTop;
        const yy = (y & 3) << 2;
        for (let x = 0; x < BW; x++) {
          if (!STREET_MATS.has(this.fmat[y * BW + x])) continue;
          const sy = walkTop - 1 - dy * 2;
          const j = (sy * BW + x) * 4;
          const r = emit[j], g = emit[j + 1], b = emit[j + 2];
          if (r + g + b < 8) continue;
          const a = (0.5 - dy * 0.03) * wet * (0.4 + (BAYER[yy | (x & 3)] / 16) * 0.8);
          const i = (y * BW + x) * 4;
          pix[i] = Math.min(255, pix[i] + r * a);
          pix[i + 1] = Math.min(255, pix[i + 1] + g * a);
          pix[i + 2] = Math.min(255, pix[i + 2] + b * a);
        }
      }
      // Feed a bit of the road back into the glow
      for (let y = roadTop; y < BH; y += 1) {
        for (let x = 0; x < BW; x++) {
          if (!STREET_MATS.has(this.fmat[y * BW + x])) continue;
          const i = (y * BW + x) * 4;
          const sy = Math.round(roadTop - 3 - (y - roadTop) * 3);
          if (sy < 0) continue;
          const j = (sy * BW + x) * 4;
          emit[i] = Math.max(emit[i], emit[j] * 0.14 * wet);
          emit[i + 1] = Math.max(emit[i + 1], emit[j + 1] * 0.14 * wet);
          emit[i + 2] = Math.max(emit[i + 2], emit[j + 2] * 0.14 * wet);
        }
      }
    }

    drawRain(dt) {
      const rain = this.rain;
      if (rain <= 0.01) return;
      const pix = this.rgba;
      const count = Math.floor(this.rainDrops.length * rain);
      for (let n = 0; n < count; n++) {
        const d = this.rainDrops[n];
        d.y += d.v * dt;
        d.x -= d.v * 0.12 * dt;
        if (d.y > 150) {
          // Land: a ripple on the road
          if (this.rand() < 0.5) {
            const rip = this.ripples[n % this.ripples.length];
            rip.x = Math.round(d.x);
            rip.y = ROAD + Math.floor(this.rand() * 22);
            rip.a = 1;
          }
          d.y = -PAD_Y - this.rand() * 30;
          d.x = this.rand() * BW - PAD_X;
        }
        for (let j = 0; j < d.l; j++) {
          const x = Math.round(d.x - j * 0.12) + PAD_X;
          const y = Math.round(d.y - j) + PAD_Y;
          if (x < 0 || x >= BW || y < 0 || y >= BH) continue;
          const i = (y * BW + x) * 4;
          pix[i] = Math.min(255, pix[i] + 26);
          pix[i + 1] = Math.min(255, pix[i + 1] + 30);
          pix[i + 2] = Math.min(255, pix[i + 2] + 44);
        }
      }
      for (const rip of this.ripples) {
        if (rip.a <= 0) continue;
        rip.a -= dt * 3.2;
        const span = Math.round((1 - rip.a) * 3);
        for (let s = -span; s <= span; s++) {
          if (Math.abs(s) < span - 1) continue;
          const x = rip.x + s + PAD_X;
          const y = rip.y + PAD_Y;
          if (x < 0 || x >= BW || y < 0 || y >= BH) continue;
          if (!STREET_MATS.has(this.fmat[y * BW + x])) continue;
          const i = (y * BW + x) * 4;
          pix[i] = Math.min(255, pix[i] + 30);
          pix[i + 1] = Math.min(255, pix[i + 1] + 34);
          pix[i + 2] = Math.min(255, pix[i + 2] + 48);
        }
      }
    }
  }

  // ---- Shaders
  const VERT = `#version 300 es
void main() {
  vec2 v = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

  const DOWN = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel, uSize;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 h = uTexel;
  o = texture(uTex, uv) * 4.0;
  o += texture(uTex, uv + vec2(-h.x, -h.y));
  o += texture(uTex, uv + vec2( h.x, -h.y));
  o += texture(uTex, uv + vec2(-h.x,  h.y));
  o += texture(uTex, uv + vec2( h.x,  h.y));
  o /= 8.0;
}`;

  const UP = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel, uSize;
uniform float uGain;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 h = uTexel;
  vec4 c = texture(uTex, uv + vec2(-2.0 * h.x, 0.0));
  c += texture(uTex, uv + vec2(-h.x, h.y)) * 2.0;
  c += texture(uTex, uv + vec2(0.0, 2.0 * h.y));
  c += texture(uTex, uv + vec2(h.x, h.y)) * 2.0;
  c += texture(uTex, uv + vec2(2.0 * h.x, 0.0));
  c += texture(uTex, uv + vec2(h.x, -h.y)) * 2.0;
  c += texture(uTex, uv + vec2(0.0, -2.0 * h.y));
  c += texture(uTex, uv + vec2(-h.x, -h.y)) * 2.0;
  o = c / 12.0 * uGain;
}`;

  const SHELL = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uWorld, uBloom, uWipe;
uniform vec2 uRes, uPill, uOrigin, uWorldSize;
uniform vec4 uLens;
uniform vec2 uTube;
uniform float uBezel, uK, uDark, uRain, uTime, uLift, uDensity, uLod;
uniform vec3 uRun[6];
out vec4 o;

const vec3 PINK = vec3(1.0, 0.13, 0.55);
const vec3 CYAN = vec3(0.08, 0.86, 1.0);

float rb(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 worldUv(vec2 p) {
  vec2 f = p + 0.5 * uRes;
  return vec2(f.x - uOrigin.x, uOrigin.y - f.y) / uK / uWorldSize;
}
vec3 bloomAt(vec2 p) {
  return texture(uBloom, worldUv(p)).rgb;
}
vec3 glowOf(vec2 p) {
  // Tight halo and a wide haze from the same chain
  vec3 b = bloomAt(p);
  return b * (0.55 + uDark * 0.75);
}
vec3 scene(vec2 p, float lod) {
  vec3 c = textureLod(uWorld, worldUv(p), lod + uLod).rgb;
  return 1.0 - (1.0 - c) * (1.0 - clamp(glowOf(p) * 0.55, 0.0, 1.0));
}

// Beaded water on the pane: a coarse layer and a fine one, each bead swelling and drying on its own
vec3 beads(vec2 p, float cell, float seed) {
  vec2 g = p / cell + seed;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float a = hash(id + seed);
  float b = hash(id * 1.7 + 3.1);
  float c = hash(id * 2.3 + 7.7);
  vec2 d = f - (vec2(a, b) - 0.5) * 0.62;
  float life = sin(uTime * (0.1 + c * 0.25) + c * 40.0);
  float rad = (0.09 + a * b * 0.27) * smoothstep(-0.4, 0.5, life);
  if (rad <= 0.001) return vec3(0.0);
  float q = length(d * vec2(1.0, 0.86)) / rad;
  if (q >= 1.0) return vec3(0.0);
  float m = smoothstep(1.0, 0.82, q);
  return vec3(d / rad * q, m);
}
// Pack the strongest of everything on the glass: xy = bend, z = coverage
vec3 waterAt(vec2 p) {
  float cell = uK * 8.0;
  vec3 w = beads(p, cell, 0.0);
  vec3 w2 = beads(p, cell * 0.55, 11.0);
  if (w2.z > w.z) w = w2;
  w.z *= smoothstep(0.1, 0.85, uRain);
  // Runners slide down in fits, dragging a wet trail
  for (int i = 0; i < 6; i++) {
    vec3 r = uRun[i];
    if (r.z <= 0.0) continue;
    vec2 d = (p - r.xy) / r.z;
    d.y *= 0.8;
    float q = length(d);
    if (q < 1.0) {
      float m = smoothstep(1.0, 0.8, q);
      if (m > w.z) w = vec3(d * q, m);
    }
  }
  // The lens wipes the pane as it passes, water grows back behind it
  float wipe = texture(uWipe, vec2(0.5 + p.x / (uRes.x), 0.5)).r;
  w.z *= 1.0 - smoothstep(0.05, 0.75, wipe);
  return w;
}

float softBox(vec2 p, vec2 c, vec2 h, float s) {
  vec2 q = abs(p - c) - h;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  return 1.0 - smoothstep(-s, s, d);
}

// The window pane, with water on it
vec3 pane(vec2 p) {
  vec3 w = uRain > 0.01 ? waterAt(p) : vec3(0.0);
  vec3 c = scene(p, 0.0);
  if (w.z > 0.002) {
    float r = uK * 8.0;
    // Drops flip and shrink what's behind them
    vec3 seen = scene(p - w.xy * r * 1.15, 1.0) * 1.12;
    float rim = pow(length(w.xy), 3.0);
    seen = mix(seen, seen * 0.42, rim * 0.8);
    float spark = smoothstep(0.82, 0.98, dot(normalize(w.xy + 1e-4), normalize(vec2(-0.45, 0.9)))) * smoothstep(0.35, 0.65, length(w.xy)) * smoothstep(0.95, 0.75, length(w.xy));
    seen += spark * mix(vec3(0.9), vec3(0.75, 0.8, 1.0), uDark) * 0.5;
    c = mix(c, seen, w.z);
  }
  return c;
}

vec3 envSky(vec3 R) {
  // A studio by day, a dim room lit by the city by night
  vec3 hi = mix(vec3(1.0, 0.99, 0.96), vec3(0.34, 0.34, 0.52), uDark);
  vec3 lo = mix(vec3(0.66, 0.64, 0.58), vec3(0.02, 0.02, 0.05), uDark);
  vec3 c = mix(lo, hi, smoothstep(-0.7, 0.8, R.y));
  vec2 s = R.xy / (1.0 + max(R.z, 0.0));
  c += hi * softBox(s, vec2(-0.12, 0.55), vec2(0.5, 0.1), 0.16) * 0.9;
  return c;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag - 0.5 * uRes;
  float d = rb(p, uPill, uPill.y);
  float dw = d + uBezel;
  float H = uPill.y;

  vec2 tubeLv = uTube;
  float tubeLine = -uBezel * 0.5;

  // ---- Wall behind: a shadow, and the tube's light in the night
  vec3 wallGlow = vec3(0.0);
  float wallAlpha = 0.0;
  if (d > -2.0) {
    float wide = rb(p + vec2(0.0, H * 0.11), uPill, H);
    float near = rb(p + vec2(0.0, H * 0.025), uPill, H);
    float shadow = 0.26 * (1.0 - smoothstep(-H * 0.18, H * 0.3, wide)) + 0.3 * (1.0 - smoothstep(-H * 0.02, H * 0.07, near));
    shadow *= mix(1.0, 0.75, uDark);
    float out1 = max(d, 0.0);
    float side = smoothstep(-uPill.x * 0.8, uPill.x * 0.8, p.x);
    vec3 tint = PINK * tubeLv.x * (1.0 - side) + CYAN * tubeLv.y * side;
    wallGlow = tint * (exp(-out1 / (H * 0.1)) * 0.42 + exp(-out1 / (H * 0.32)) * 0.34) * uDark;
    // Fade before the canvas edge
    vec2 toEdge = 0.5 * uRes - abs(p);
    float fade = smoothstep(0.0, H * 0.35, min(toEdge.x, toEdge.y));
    wallGlow *= fade;
    shadow *= fade;
    wallAlpha = shadow;
  }

  vec3 color = wallGlow;
  float alpha = max(wallAlpha, max(wallGlow.r, max(wallGlow.g, wallGlow.b)));

  if (d < 1.0) {
    vec3 body = vec3(0.0);

    // ---- Bezel
    if (dw > -1.0) {
      float inner = uPill.x - uPill.y;
      vec2 q = p;
      q.x = sign(p.x) * max(abs(p.x) - inner, 0.0);
      vec2 g = q / max(length(q), 1e-3);
      float t = clamp(-d / uBezel, 0.0, 1.0);
      float s = t * 2.0 - 1.0;
      float slope = -s * s * s * 1.35;
      // Chamfer at the inner edge falls away sharply
      float chamfer = smoothstep(0.76, 0.86, t);
      slope = mix(slope, -1.2, chamfer);
      vec3 N = normalize(vec3(g * slope, 1.0));
      vec3 R = reflect(vec3(0.0, 0.0, -1.0), N);

      vec3 albedo = mix(vec3(0.93, 0.9, 0.84), vec3(0.055, 0.055, 0.08), uDark);
      float dif = 0.66 + 0.34 * clamp(dot(N, normalize(vec3(-0.25, 0.75, 0.62))), 0.0, 1.0);
      float fres = 0.05 + 0.95 * pow(1.0 - N.z, 3.2);
      vec3 c = albedo * dif;
      c = mix(c, envSky(R), clamp(fres * 0.85 + mix(0.1, 0.16, uDark), 0.0, 1.0));

      // Inner chamfer is polished: it mirrors the actual street
      float edgeDist = max(uBezel + d, 0.0);
      vec3 mirror = scene(p - g * (edgeDist * 2.0 + uK * 0.5), 2.0);
      c = mix(c, mirror * mix(0.82, 1.0, uDark), chamfer * 0.55);

      // City light across the whole metal, in its own colours
      vec3 city = glowOf(p - g * uBezel * 2.2);
      c += city * mix(0.08, 0.34, uDark) * (0.3 + 0.7 * clamp(t * 1.2, 0.0, 1.0));

      // ---- Neon tube, seated in the bezel
      float tr = max(uBezel * 0.085, 1.1 * uDensity);
      float td = abs(d - tubeLine);
      // Walk along the tube. Two tubes, joined with blacked-out ends at top and bottom centre.
      float side = step(0.0, p.x);
      float lv = mix(tubeLv.x, tubeLv.y, side);
      vec3 hue = mix(PINK, CYAN, side);
      float gapW = uBezel * 0.42;
      float gap = abs(p.x) < gapW && abs(p.y) > H * 0.5 ? 1.0 : 0.0;
      float gapSoft = (1.0 - smoothstep(gapW * 0.6, gapW * 2.6, abs(p.x))) * step(H * 0.5, abs(p.y));
      float capStart = abs(p.x) < gapW + uBezel * 0.7 && abs(p.y) > H * 0.5 ? 1.0 : 0.0;

      // Standoff clips along the run
      float R0 = H + tubeLine;
      float along;
      if (abs(p.x) < inner) along = p.y > 0.0 ? abs(p.x) : 2.0 * inner + 3.14159 * R0 - abs(p.x);
      else {
        vec2 qq = p - vec2(sign(p.x) * inner, 0.0);
        along = inner + (1.5708 - atan(qq.y, abs(qq.x))) * R0;
      }
      float run = 2.0 * inner + 3.14159 * R0;
      float spacing = run / floor(run / (H * 0.78) + 0.5);
      float cd = abs(mod(along, spacing) - spacing * 0.5);
      float clip = (1.0 - smoothstep(tr * 1.0, tr * 1.4, cd)) * (1.0 - smoothstep(tr * 1.6, tr * 2.1, td));

      // Halo on the metal
      float halo = exp(-td / (uBezel * 0.15)) * 0.8 + exp(-td / (uBezel * 0.42)) * 0.42;
      c += hue * lv * uDark * halo * (1.0 - gapSoft * 0.9);
      // Soft contact shadow of the tube (day)
      c *= 1.0 - (1.0 - uDark) * 0.22 * (1.0 - smoothstep(tr, tr * 2.6, abs(d - tubeLine - tr * 1.1)));

      // The glass itself
      float tube = (1.0 - smoothstep(tr * 0.8, tr * 1.15, td)) * (1.0 - gap);
      if (tube > 0.0) {
        float across = clamp((d - tubeLine) / tr, -1.0, 1.0);
        float roll = sqrt(max(1.0 - across * across, 0.0));
        // Unlit: milky glass catching a sliver of light
        vec3 cold = mix(vec3(0.95, 0.94, 0.9), vec3(0.14, 0.14, 0.2), uDark) * (0.74 + 0.26 * roll);
        cold += pow(roll, 8.0) * mix(0.25, 0.08, uDark);
        // Lit: white-hot along the middle, saturated toward the skin
        vec3 lit = mix(hue, vec3(1.0), smoothstep(0.55, 1.0, roll) * 0.86);
        vec3 tubeC = mix(cold, lit * 1.25, lv * smoothstep(0.1, 0.7, uDark + lv * 0.4));
        // Painted-out electrode ends
        tubeC = mix(tubeC, vec3(0.03, 0.03, 0.04) + 0.12 * pow(roll, 6.0), capStart);
        c = mix(c, tubeC, tube);
      }
      c = mix(c, mix(vec3(0.52, 0.52, 0.5), vec3(0.09, 0.09, 0.12), uDark), clip);

      body = c;
    }

    // ---- Window
    if (dw < 1.0) {
      float winR = uPill.y - uBezel;
      vec2 lc = uLens.xy;
      vec2 he = uLens.zw;
      float lr = min(he.x, he.y);
      vec2 lq = p - lc;
      float ld = rb(lq, he, lr);

      vec3 c = ld < 2.0 ? scene(p, 0.0) : pane(p);

      // Pane sheen, only just there
      float sheen = smoothstep(winR * 0.15, winR * 1.05, p.y + p.x * 0.1);
      c = mix(c, vec3(1.0), sheen * sheen * mix(0.14, 0.03, uDark));

      // Set back into the frame
      float top = rb(p - vec2(0.0, winR * 0.05), uPill - uBezel, winR);
      float depth = exp(max(dw, -winR) / (winR * 0.05)) * 0.5 + exp(min(top, 0.0) / (winR * 0.09)) * 0.44;
      c = mix(c, mix(vec3(0.14, 0.12, 0.16), vec3(0.0, 0.0, 0.02), uDark), clamp(depth, 0.0, 0.9));

      // Lens shadow
      float lift = 0.05 + uLift * 0.05;
      float sd = rb(lq + vec2(lr * 0.02, lr * lift * 1.7), he, lr);
      float sh = 1.0 - smoothstep(-lr * 0.16, lr * (0.17 + uLift * 0.12), sd);
      c = mix(c, vec3(0.02, 0.02, 0.05), sh * mix(0.42, 0.62, uDark) * step(0.0, ld));
      // Light gathered through the glass lands just under it
      float cd = rb(lq + vec2(-lr * 0.1, lr * 0.11), he * 0.99, lr);
      float caustic = smoothstep(lr * 0.13, 0.0, abs(cd)) * smoothstep(0.0, -1.0, lq.y / lr + 0.2) * step(0.0, ld);
      c += caustic * mix(vec3(0.42, 0.38, 0.3), glowOf(lc - vec2(0.0, lr * 0.35)) * 1.1 + vec3(0.03), uDark);

      // ---- Lens
      if (ld < 1.0) {
        vec2 innerL = max(he - lr, 0.0);
        vec2 axis = lq - clamp(lq, -innerL, innerL);
        float rad = length(axis);
        vec2 gr = axis / max(rad, 1e-3);
        float rho = clamp(rad / lr, 0.0, 1.0);

        // Flat through the middle, falls away fast at the rim
        const float pw = 4.0;
        float rp = pow(rho, pw);
        float slope = pow(rho, pw - 1.0) * pow(max(1.0 - rp, 2e-3), 1.0 / pw - 1.0);
        vec3 N = normalize(vec3(gr * slope, 1.0));
        vec3 R = reflect(vec3(0.0, 0.0, -1.0), N);
        vec2 lp = lq / lr;

        float mag = 1.2 + uLift * 0.05;
        vec2 base = lc + lq / mag;
        float bend = pow(rho, 8.0) * lr * (0.18 + uLift * 0.02);
        vec2 src = base + gr * bend;
        // Footprint, so the compressed rim doesn't shimmer
        float foot = length(dFdx(src)) + length(dFdy(src));
        float lod = max(0.0, log2(foot * 0.5 / uK));
        vec3 seen;
        float ca = 0.015 * smoothstep(0.8, 1.0, rho);
        if (ca > 0.001) {
          vec2 off = gr * bend;
          seen.r = scene(base + off * (1.0 - ca) + gr * ca * lr * 0.06, lod).r;
          seen.g = scene(base + off, lod).g;
          seen.b = scene(base + off * (1.0 + ca) - gr * ca * lr * 0.06, lod).b;
        } else {
          seen = scene(src, lod);
        }
        vec3 lens = seen * mix(1.03, 1.08, uDark);

        // Thickness: darkness at the rim, not an outline
        lens = mix(lens, mix(vec3(0.12, 0.13, 0.17), vec3(0.0, 0.0, 0.03), uDark), pow(rho, 14.0) * 0.55);

        // Light pools inside the lower edge
        float pool = smoothstep(0.1, 0.95, -lp.y * 0.92 + lp.x * 0.22) * smoothstep(1.0, 0.86, rho) * smoothstep(0.5, 0.88, rho);
        lens += mix(vec3(0.34, 0.33, 0.3), glowOf(lc + gr * lr * 0.7) * 0.75 + vec3(0.02), uDark) * pool;

        // Big soft window high up
        float broad = softBox(lp, vec2(-0.1, 0.72), vec2(0.42, 0.1), 0.26) * smoothstep(0.98, 0.7, rho);
        lens = mix(lens, mix(vec3(1.0), vec3(0.74, 0.76, 1.0), uDark), broad * mix(0.34, 0.07, uDark));

        // Glints: a small crisp one up top, a fainter one bottom right
        float la = atan(gr.y, gr.x);
        float arc1 = exp(-pow((rho - 0.83) / 0.026, 2.0)) * smoothstep(0.42, 0.1, abs(la - 2.15));
        float arc2 = exp(-pow((rho - 0.86) / 0.016, 2.0)) * smoothstep(0.26, 0.05, abs(la + 0.86));
        lens += arc1 * mix(0.82, 0.5, uDark) + arc2 * mix(0.42, 0.26, uDark);

        // Mirror at the rim, and the neon in it is the neon that's really out there
        float fres = pow(1.0 - N.z, 2.6);
        vec3 refl = envSky(R);
        refl += glowOf(lc + gr * lr * 1.3) * uDark * 2.2;
        lens = mix(lens, refl, clamp(fres * mix(0.5, 0.56, uDark), 0.0, 0.6));
        // The frame's tubes catch in the glass
        float side = smoothstep(-0.2, 0.9, gr.x * 0.8 + p.x / uPill.x);
        lens += (mix(PINK * uTube.x, CYAN * uTube.y, side)) * uDark * fres * 0.34;

        // Hairline where it meets the air
        float hair = smoothstep(lr * 0.018 + 0.6, 0.0, abs(ld + lr * 0.012));
        float dirH = 0.25 + 0.75 * smoothstep(-0.5, 0.9, dot(gr, normalize(vec2(-0.5, 0.86))));
        lens += hair * dirH * mix(0.34, 0.26, uDark);

        c = mix(c, lens, 1.0 - smoothstep(-0.8, 0.8, ld));
      }

      body = mix(body, c, 1.0 - smoothstep(-0.8, 0.8, dw));
    }

    float cover = 1.0 - smoothstep(-0.8, 0.8, d);
    color = mix(color, body, cover);
    alpha = mix(alpha, 1.0, cover);
  }

  // Keep gradients free of bands
  float n = hash(frag * 0.31 + fract(uTime * 0.01)) + hash(frag * 0.57) - 1.0;
  color += n * 0.9 / 255.0 * min(alpha * 4.0, 1.0);
  o = vec4(clamp(color, 0.0, 1.0), alpha);
}`;

  const css = `
:host { display: block; position: relative; width: 100%; aspect-ratio: 2 / 1; -webkit-tap-highlight-color: transparent; }
canvas { position: absolute; display: block; pointer-events: none; image-rendering: pixelated; }
button {
  position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; background: transparent;
  border-radius: 9999px; cursor: grab; touch-action: pan-y; user-select: none; -webkit-user-select: none; outline: none;
}
button:active { cursor: grabbing; }
button:focus-visible { outline: 2px solid #ff2a8c; outline-offset: 6px; box-shadow: 0 0 0 2px #14e0ff; }
.vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;

  const OVERHANG = 0.32; // canvas spills past the host by this share of the host's height

  class TokyoSwitch extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${css}</style><canvas aria-hidden="true"></canvas>
        <button type="button" role="switch" aria-checked="false" aria-label="Dark mode"></button>
        <span class="vh" role="status" aria-live="polite"></span>`;
      this.canvas = root.querySelector('canvas');
      this.button = root.querySelector('button');
      this.statusEl = root.querySelector('.vh');
      this.world = new World();
      this.x = 0;
      this.v = 0;
      this.target = 0;
      this.moving = false;
      this._checked = false;
      this.branch = 'pm';
      this.nightHour = HOUR_NIGHT;
      this.amStart = HOUR_NIGHT;
      this.stretch = 0;
      this.stretchV = 0;
      this.lift = 0;
      this.liftTarget = 0;
      this.hurry = 0;
      this.drag = null;
      this.time = 0;
      this.accum = 1;
      this.wipe = new Uint8Array(64);
      this.runners = Array.from({ length: 6 }, () => ({ x: 0, y: 0, r: 0, wait: Math.random() * 6, v: 0 }));
      this.calm = matchMedia('(prefers-reduced-motion: reduce)');
      this.bindInput();
    }

    connectedCallback() {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this);
      this.io = new IntersectionObserver((entries) => {
        this.visible = entries.some((e) => e.isIntersecting);
        this.wake();
      });
      this.io.observe(this);
      this.onVis = () => this.wake();
      document.addEventListener('visibilitychange', this.onVis);
      if (this.hasAttribute('checked')) this.jump(true);
      this.resize();
    }

    disconnectedCallback() {
      this.ro.disconnect();
      this.io.disconnect();
      document.removeEventListener('visibilitychange', this.onVis);
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }

    // ---- API
    get checked() {
      return this._checked;
    }
    set checked(v) {
      this.setChecked(Boolean(v), true);
    }
    get position() {
      return this.x;
    }
    set position(v) {
      this.x = clamp(v);
      this.v = 0;
      this.moving = false;
      this.branch = 'pm';
      this.wake();
    }
    setChecked(night, animate) {
      if (animate && !this.calm.matches) {
        this.beginTravel();
        this.target = night ? 1 : 0;
        this.moving = true;
        this.wake();
      } else {
        this.commit(night);
      }
    }
    // Instant, for restoring a saved choice on load
    jump(night) {
      this.commit(night, true);
      this.settleGroups();
    }
    settleGroups() {
      this.world.tick(0.2, this.hour(), { calm: true });
      this.dirty = true;
      this.wake();
    }

    hour() {
      if (this.branch === 'am') return mix(36, this.amStart, this.x);
      return mix(HOUR_DAY, this.nightHour, this.x);
    }

    beginTravel() {
      if (this.x <= 0.0005) this.branch = 'pm';
      else if (this.x >= 0.9995) {
        this.branch = 'am';
        this.amStart = this.nightHour;
      }
    }

    commit(night, quiet) {
      this.x = night ? 1 : 0;
      this.v = 0;
      this.moving = false;
      if (!night) this.nightHour = HOUR_NIGHT;
      this.branch = 'pm';
      if (this._checked !== night) {
        this._checked = night;
        this.button.setAttribute('aria-checked', String(night));
        this.toggleAttribute('checked', night);
        this.statusEl.textContent = night ? 'Night in Tokyo, signs on' : 'Daytime in Tokyo';
        if (!quiet) {
          this.dispatchEvent(new CustomEvent('change', { bubbles: true, composed: true, detail: { night } }));
          if (navigator.vibrate) navigator.vibrate(6);
        }
      }
      this.emitScrub();
    }

    emitScrub() {
      const hour = this.hour();
      const dark = smooth(17.6, 19.4, hour) * (1 - smooth(28.7, 30.2, hour));
      if (dark === this.lastDark && hour === this.lastHour) return;
      this.lastDark = dark;
      this.lastHour = hour;
      this.dispatchEvent(new CustomEvent('scrub', { bubbles: true, composed: true, detail: { position: this.x, hour: hour % 24, dark } }));
    }

    // ---- Layout
    resize() {
      const box = this.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const pad = Math.round(box.height * OVERHANG);
      const cssW = box.width + pad * 2;
      const cssH = box.height + pad * 2;
      const W = Math.round(cssW * dpr);
      const H = Math.round(cssH * dpr);
      const canvas = this.canvas;
      Object.assign(canvas.style, { left: `${-pad}px`, top: `${-pad}px`, width: `${cssW}px`, height: `${cssH}px` });
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const pillW = box.width * dpr;
      const pillH = box.height * dpr;
      const bezel = pillH * 0.078;
      const winH = pillH - bezel * 2;
      const winW = pillW - bezel * 2;

      // Keep the same 150 rows visible so resizing never changes the scene's framing.
      const k = winH / 150;
      const lensR = (winH / 2) * 0.94;
      const lim = winW / 2 - (winH / 2 - lensR) - lensR;
      this.shape = {
        W, H, dpr, pillW, pillH, bezel, winH, winW, k,
        ox: W / 2 - (160 + PAD_X) * k,
        oy: H / 2 - winH / 2 + BH * k,
        lensR, travel: lim * 2, travelCss: (lim * 2) / dpr,
      };
      this.initGl();
      this.dirty = true;
      this.world.tick(1 / 30, this.hour(), { calm: this.calm.matches });
      this.wake();
    }

    // ---- GL
    initGl() {
      if (this.gl || this.noGl) return;
      const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' });
      if (!gl) {
        this.noGl = true;
        this.ctx = this.canvas.getContext('2d');
        this.low = document.createElement('canvas');
        this.low.width = BW;
        this.low.height = BH;
        return;
      }
      this.gl = gl;
      if (!this.lostBound) {
        this.lostBound = true;
        this.canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          this.gl = null;
        });
        this.canvas.addEventListener('webglcontextrestored', () => this.resize());
      }
      const compile = (fs) => {
        const prog = gl.createProgram();
        for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, fs]]) {
          const s = gl.createShader(type);
          gl.shaderSource(s, src);
          gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
          gl.attachShader(prog, s);
        }
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(prog));
        const loc = {};
        const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) {
          const name = gl.getActiveUniform(prog, i).name.replace('[0]', '');
          loc[name] = gl.getUniformLocation(prog, name);
        }
        return { prog, loc };
      };
      this.pDown = compile(DOWN);
      this.pUp = compile(UP);
      this.pShell = compile(SHELL);
      this.vao = gl.createVertexArray();

      const tex = (min, mag) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this.texWorld = tex(gl.NEAREST_MIPMAP_LINEAR, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, BW, BH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.texEmit = tex(gl.LINEAR, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, BW, BH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.texWipe = tex(gl.LINEAR, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 64, 1, 0, gl.RED, gl.UNSIGNED_BYTE, this.wipe);

      const hdr = gl.getExtension('EXT_color_buffer_float');
      this.levels = [];
      let w = BW, h = BH;
      for (let i = 0; i < 5; i++) {
        w = Math.max(2, w >> 1);
        h = Math.max(2, h >> 1);
        const t = tex(gl.LINEAR, gl.LINEAR);
        if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        this.levels.push({ t, fbo, w, h });
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    uploadWorld() {
      const gl = this.gl;
      if (!gl) return;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texWorld);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BW, BH, gl.RGBA, gl.UNSIGNED_BYTE, this.world.rgba);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, this.texEmit);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BW, BH, gl.RGBA, gl.UNSIGNED_BYTE, this.world.emit);

      // Bloom: downsample then add back up
      gl.bindVertexArray(this.vao);
      gl.disable(gl.BLEND);
      gl.useProgram(this.pDown.prog);
      gl.uniform1i(this.pDown.loc.uTex, 0);
      let src = this.texEmit, sw = BW, sh = BH;
      for (const lv of this.levels) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, lv.fbo);
        gl.viewport(0, 0, lv.w, lv.h);
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.uniform2f(this.pDown.loc.uTexel, 0.5 / sw, 0.5 / sh);
        gl.uniform2f(this.pDown.loc.uSize, lv.w, lv.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = lv.t;
        sw = lv.w;
        sh = lv.h;
      }
      gl.useProgram(this.pUp.prog);
      gl.uniform1i(this.pUp.loc.uTex, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      const gains = [0.62, 0.62, 0.66, 0.7];
      for (let i = this.levels.length - 1; i > 0; i--) {
        const from = this.levels[i];
        const to = this.levels[i - 1];
        gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
        gl.viewport(0, 0, to.w, to.h);
        gl.bindTexture(gl.TEXTURE_2D, from.t);
        gl.uniform2f(this.pUp.loc.uTexel, 0.5 / from.w, 0.5 / from.h);
        gl.uniform2f(this.pUp.loc.uSize, to.w, to.h);
        gl.uniform1f(this.pUp.loc.uGain, gains[i - 1]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    draw() {
      const s = this.shape;
      if (!s) return;
      if (this.noGl) return this.draw2d();
      const gl = this.gl;
      if (!gl) return;
      gl.viewport(0, 0, s.W, s.H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindVertexArray(this.vao);
      const { prog, loc } = this.pShell;
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texWorld);
      gl.uniform1i(loc.uWorld, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.levels[0].t);
      gl.uniform1i(loc.uBloom, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.texWipe);
      gl.uniform1i(loc.uWipe, 2);
      gl.uniform2f(loc.uRes, s.W, s.H);
      gl.uniform2f(loc.uPill, s.pillW / 2, s.pillH / 2);
      gl.uniform2f(loc.uOrigin, s.ox, s.oy);
      gl.uniform2f(loc.uWorldSize, BW, BH);
      gl.uniform1f(loc.uBezel, s.bezel);
      gl.uniform1f(loc.uK, s.k);
      gl.uniform1f(loc.uDark, this.world.dark);
      gl.uniform1f(loc.uRain, this.world.rain);
      gl.uniform1f(loc.uTime, this.time);
      gl.uniform1f(loc.uLift, this.lift);
      gl.uniform1f(loc.uDensity, s.dpr);
      gl.uniform1f(loc.uLod, Math.max(0, Math.log2(1 / s.k)));
      gl.uniform2f(loc.uTube, this.world.tubeLevels?.[0] || 0, this.world.tubeLevels?.[1] || 0);
      const st = clamp(this.stretch, -0.5, 1.2);
      const r = s.lensR * (1 + 0.018 * this.lift);
      const hx = r * (1 + 0.2 * st);
      const hy = r * (1 - 0.08 * st);
      const lim = s.winW / 2 - (s.winH / 2 - s.lensR) - hx;
      const cx = clamp((this.x - 0.5) * s.travel, -lim, lim);
      gl.uniform4f(loc.uLens, cx, 0, hx, hy);
      const run = new Float32Array(18);
      this.runners.forEach((d, i) => {
        run[i * 3] = d.x * s.winW * 0.5;
        run[i * 3 + 1] = d.y * s.winH * 0.5;
        run[i * 3 + 2] = this.world.rain > 0.2 ? d.r * s.k : 0;
      });
      gl.uniform3fv(loc.uRun, run);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    draw2d() {
      // No WebGL: the world, clipped to the pill, with a plain disc for the thumb
      const s = this.shape;
      const g = this.ctx;
      this.low.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(this.world.rgba.buffer), BW, BH), 0, 0);
      g.clearRect(0, 0, s.W, s.H);
      g.save();
      g.beginPath();
      g.roundRect((s.W - s.pillW) / 2, (s.H - s.pillH) / 2, s.pillW, s.pillH, s.pillH / 2);
      g.fillStyle = this.world.dark > 0.5 ? '#0e0e16' : '#eee8db';
      g.fill();
      g.beginPath();
      g.roundRect((s.W - s.winW) / 2, (s.H - s.winH) / 2, s.winW, s.winH, s.winH / 2);
      g.clip();
      g.imageSmoothingEnabled = false;
      g.drawImage(this.low, s.ox, s.H - s.oy, BW * s.k, BH * s.k);
      g.restore();
      g.fillStyle = 'rgba(255,255,255,.35)';
      g.beginPath();
      g.arc(s.W / 2 + (this.x - 0.5) * s.travel, s.H / 2, s.lensR, 0, Math.PI * 2);
      g.fill();
    }

    // ---- Loop
    wake() {
      if (this.raf || !this.visible || document.hidden) return;
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }

    frame(now) {
      this.raf = 0;
      if (!this.visible || document.hidden) return;
      const dt = Math.min((now - this.last) / 1000, 1 / 20);
      this.last = now;
      const calm = this.calm.matches;
      this.time += calm ? 0 : dt;
      this.stepThumb(dt, calm);
      this.emitScrub();
      this.stepWater(dt, calm);

      // World runs at 30 Hz. The lens and the glass run at display rate.
      this.accum += dt;
      let paint = this.drag || this.moving || Math.abs(this.stretch) > 0.002 || Math.abs(this.liftTarget - this.lift) > 0.002;
      const hour = this.hour();
      if (this.dirty || (this.accum >= 1 / 30 && (!calm || hour !== this.tickedHour))) {
        const step = Math.min(this.accum, 0.1);
        this.accum = 0;
        this.tickedHour = hour;
        this.world.tick(step, hour, { calm, hurry: this.hurry });
        this.uploadWorld();
        this.dirty = false;
        paint = true;
      }
      if (paint) this.draw();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }

    stepThumb(dt, calm) {
      if (this.drag) {
        const before = this.x;
        const want = clamp(this.drag.want);
        this.x = mix(this.x, want, clamp(dt * 24));
        this.v = (this.x - before) / Math.max(dt, 1 / 240);
      } else if (this.moving) {
        if (calm) {
          if (this.target === 0 || this.target === 1) this.commit(this.target === 1);
          else {
            this.x = this.target;
            this.v = 0;
            this.moving = false;
          }
        } else {
          const omega = 13;
          const zeta = 0.78;
          const acc = omega * omega * (this.target - this.x) - 2 * zeta * omega * this.v;
          this.v += acc * dt;
          this.x += this.v * dt;
          // Bumps off the ends and squashes against them
          if (this.x > 1) {
            this.x = 1;
            this.stretchV -= Math.abs(this.v) * 1.5;
            this.v *= -0.22;
          } else if (this.x < 0) {
            this.x = 0;
            this.stretchV -= Math.abs(this.v) * 1.5;
            this.v *= -0.22;
          }
          if (Math.abs(this.target - this.x) < 0.002 && Math.abs(this.v) < 0.03) {
            if (this.target === 0 || this.target === 1) this.commit(this.target === 1);
            else {
              this.x = this.target;
              this.v = 0;
              this.moving = false;
            }
          }
        }
      } else if (this.x >= 1 && !calm && this.nightHour < 26) {
        // The clock keeps running through the night
        this.nightHour += dt / 90;
      }
      if (!calm) {
        const goal = clamp(Math.abs(this.v) * 0.4);
        this.stretchV += (190 * (goal - this.stretch) - 13 * this.stretchV) * dt;
        this.stretch += this.stretchV * dt;
        this.lift += (this.liftTarget - this.lift) * clamp(dt * 14);
      } else {
        this.stretch = 0;
        this.lift = this.liftTarget;
      }
      this.hurry = Math.max(this.hurry - dt * 1.4, clamp(Math.abs(this.v) * 0.6));
    }

    stepWater(dt, calm) {
      if (!this.gl || !this.shape) return;
      const s = this.shape;
      // Wipe under the lens, drying back over a few seconds
      const lc = (this.x - 0.5) * s.travel;
      const span = s.lensR * 1.02;
      for (let i = 0; i < 64; i++) {
        const px = ((i + 0.5) / 64 - 0.5) * s.W;
        const covered = Math.abs(px - lc) < span ? 1 : 0;
        const next = Math.max(this.wipe[i] - dt * 255 * 0.14, covered * 255);
        this.wipe[i] = next;
      }
      if (!calm) {
        const rain = this.world.rain;
        for (const d of this.runners) {
          if (d.r <= 0) {
            d.wait -= dt;
            if (d.wait <= 0 && rain > 0.3) {
              d.r = 1.6 + Math.random() * 2.2;
              d.x = (Math.random() - 0.5) * 1.8;
              d.y = 1;
              d.v = 0;
              d.stick = 0;
            }
            continue;
          }
          // Stick, then slip
          d.stick -= dt;
          if (d.stick <= 0) {
            d.v = 0.12 + Math.random() * 0.5;
            d.stick = 0.2 + Math.random() * 0.9;
          }
          d.v *= Math.exp(-dt * 2.6);
          d.y -= d.v * dt;
          d.x += Math.sin(d.y * 19 + d.r * 7) * dt * 0.01;
          if (d.y < -1.1) {
            d.r = 0;
            d.wait = 1 + Math.random() * 5;
          }
        }
      }
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.texWipe);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RED, gl.UNSIGNED_BYTE, this.wipe);
      gl.activeTexture(gl.TEXTURE0);
    }

    // ---- Input
    bindInput() {
      const b = this.button;
      let suppressClick = 0;
      let hovering = false;
      const hover = (on) => (e) => {
        if (e.pointerType !== 'mouse') return;
        hovering = on;
        if (!this.drag) this.liftTarget = on ? 0.35 : 0;
        this.wake();
      };
      b.addEventListener('pointerenter', hover(true));
      b.addEventListener('pointerleave', hover(false));
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        this.beginTravel();
        this.moving = false;
        this.drag = { id: e.pointerId, start: e.clientX, from: this.x, want: this.x, moved: false, lastX: e.clientX, lastT: performance.now(), speed: 0 };
        this.liftTarget = 1;
        try {
          b.setPointerCapture(e.pointerId);
        } catch {
          /* still get moves without capture */
        }
        this.wake();
      });
      b.addEventListener('pointermove', (e) => {
        const d = this.drag;
        if (!d || e.pointerId !== d.id) return;
        const dx = e.clientX - d.start;
        if (Math.abs(dx) > 3) d.moved = true;
        d.want = d.from + dx / Math.max(this.shape.travelCss, 1);
        const now = performance.now();
        const ms = Math.max(now - d.lastT, 4);
        const speed = (e.clientX - d.lastX) / Math.max(this.shape.travelCss, 1) / (ms / 1000);
        d.speed = d.speed * 0.6 + speed * 0.4;
        d.lastX = e.clientX;
        d.lastT = now;
        if (Math.abs(d.speed) > 3.2) this.world.startle();
      });
      const release = (e) => {
        const d = this.drag;
        if (!d || e.pointerId !== d.id) return;
        this.drag = null;
        this.liftTarget = hovering ? 0.35 : 0;
        if (d.moved) {
          suppressClick = performance.now() + 300;
          this.target = this.x + d.speed * 0.09 >= 0.5 ? 1 : 0;
          this.v = clamp(d.speed, -3, 3);
          this.moving = true;
        }
        this.wake();
      };
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
      b.addEventListener('lostpointercapture', release);
      b.addEventListener('click', () => {
        if (performance.now() < suppressClick) return;
        this.beginTravel();
        this.target = (this.moving ? this.target >= 0.5 : this.x >= 0.5) ? 0 : 1;
        this.moving = true;
        this.wake();
      });
      b.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.05 : 0;
        const end = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : null;
        if (!step && end === null) return;
        e.preventDefault();
        if (step) {
          // Arrows work the clock directly: left is earlier, right is later. Mid-way through dawn the hours can't switch without a jump.
          if (this.branch === 'am' && this.moving) return;
          this.branch = 'pm';
          this.target = clamp((this.moving ? this.target : this.x) + step);
        } else {
          this.beginTravel();
          this.target = end;
        }
        this.moving = true;
        this.wake();
      });
    }
  }

  if (!customElements.get('tokyo-switch')) customElements.define('tokyo-switch', TokyoSwitch);
})();
