// Browser-side Cubism renderer. Mouth follows the audio that is actually playing.
const ROOT = '/static/vendor/live2d/';
const MODEL = '/static/assets/live2d/haru/haru_greeter_t05.model3.json';
const SHAPES = {
  sil: [0, .15], PP: [.015, .1], FF: [.15, .25], TH: [.22, .2],
  DD: [.25, .35], kk: [.34, .2], CH: [.25, -.15], SS: [.16, .45],
  nn: [.18, .3], RR: [.24, -.25], aa: [.74, .15],
  E: [.43, .8], I: [.24, .7], O: [.56, -.65], U: [.31, -.85],
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
let runtime;
function script(file) {
  return new Promise((resolve, reject) => {
    const node = document.createElement('script');
    node.src = ROOT + file;
    node.onload = resolve;
    node.onerror = () => { node.remove(); reject(new Error('Could not load Live2D runtime: ' + file)); };
    document.head.append(node);
  });
}
async function loadRuntime() {
  if (!runtime) runtime = (async () => {
    if (!window.Live2DCubismCore) await script('live2dcubismcore-5.2.min.js');
    if (!window.PIXI) await script('pixi-6.5.10.min.js');
    if (!window.PIXI.live2d) await script('pixi-live2d-display-0.4.0.min.js');
    // All audible output belongs to the conversation's single PCM player.
    window.PIXI.live2d.config.sound = false;
  })().catch(error => { runtime = null; throw error; });
  return runtime;
}

export class Live2DCompanion {
  constructor(element, audioCtx) {
    this.element = element; this.audioCtx = audioCtx;
    this.audioAnalyzerNode = audioCtx.createAnalyser();
    this.audioAnalyzerNode.fftSize = 512;
    this.gain = audioCtx.createGain();
    this.audioAnalyzerNode.connect(this.gain); this.gain.connect(audioCtx.destination);
    this.samples = new Float32Array(512);
    this.animQueue = []; this.isSpeaking = false; this.isStreaming = false;
    this.isRunning = false; this.stateName = 'idle'; this.moodName = 'neutral';
    this.avatar = { url: MODEL, type: 'live2d' };
    this.open = 0; this.form = .2; this.hasVisemes = false;
    this.nextBlink = performance.now() + 1800; this.blinkStart = -Infinity;
    this.lastUpdate = performance.now(); this.gesture = null;
    this.legacySources = new Set(); this.legacyTimers = new Set();
    this.stats = { frames: 0, mouthMax: 0, visemes: [], lastParameters: {} };
  }
  get animClock() { return performance.now(); }
  async load() {
    await loadRuntime();
    const PIXI = window.PIXI;
    this.app = new PIXI.Application({
      width: this.element.clientWidth, height: this.element.clientHeight,
      backgroundAlpha: 0, antialias: true, autoDensity: true,
      resolution: Math.min(devicePixelRatio, 1.7), autoStart: false,
    });
    this.element.append(this.app.view);
    this.model = await PIXI.live2d.Live2DModel.from(MODEL, {
      autoUpdate: false, autoInteract: false, motionPreload: 'NONE',
    });
    this.core = this.model.internalModel.coreModel;
    // Our subtle pose already includes breathing; avoid adding the SDK's broad head sway.
    this.model.internalModel.breath = undefined;
    this.parameterIds = new Set(this.core._parameterIds);
    this.partIds = new Set(this.core._partIds);
    this.model.anchor.set(.5, 0);
    this.app.stage.addChild(this.model);
    this.app.ticker.maxFPS = 30;
    this.app.ticker.add(() => this.model.update(this.app.ticker.deltaMS));
    // Head motion reaches the physics solver; mouth/eye values are applied last.
    this.model.internalModel.on('afterMotionUpdate', () => this.updatePose());
    this.model.internalModel.on('beforeModelUpdate', () => this.updateFace());
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.element); this.fit();
    return this;
  }
  fit() {
    if (!this.model) return;
    const width = this.element.clientWidth, height = this.element.clientHeight;
    if (!width || !height) return;
    this.app.renderer.resize(width, height);
    const compact = window.matchMedia('(max-width: 760px)').matches;
    const size = height * (compact ? 1.45 : 1.7);
    this.model.scale.set(size / this.model.internalModel.height);
    this.model.position.set(width * .57, height * .12);
  }
  parameter(id, value) {
    if (this.parameterIds.has(id)) this.core.setParameterValueById(id, value);
  }
  updatePose() {
    const now = this.animClock, t = now / 1000;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const movement = reduced ? .2 : 1;
    let gesture = 0;
    if (this.gesture) {
      const progress = (now - this.gesture.start) / this.gesture.duration;
      if (progress >= 1) this.gesture = null;
      else gesture = Math.sin(Math.PI * clamp(progress, 0, 1));
    }
    const emphasis = this.isSpeaking ? .9 : .3;
    this.poseValues = {
      ParamAngleX: movement * (2.2 * Math.sin(t * .48) + emphasis * Math.sin(t * 1.3)),
      ParamAngleY: movement * (1.1 * Math.sin(t * .65) - gesture * 3),
      ParamAngleZ: movement * 1.1 * Math.sin(t * .38),
      ParamBodyAngleX: movement * .6 * Math.sin(t * .4),
      ParamBodyAngleY: 0, ParamBodyAngleZ: movement * .35 * Math.sin(t * .45),
      ParamBreath: .45 + .25 * Math.sin(t * 1.35),
      ParamArmLA: .88 - gesture * .48, ParamArmRA: .88 - gesture * .12,
      ParamArmLB: 0, ParamArmRB: 0, ParamHandChangeR: 0, ParamHandDhangeL: 0,
      ParamHandAngleR: -.1, ParamHandAngleL: .1 + gesture * .1,
      ParamEyeBallX: now < this.eyeContactUntil ? 0 : .06 * Math.sin(t * .43),
      ParamEyeBallY: -.02,
    };
    for (const [id, value] of Object.entries(this.poseValues)) this.parameter(id, value);
  }
  updateFace() {
    const now = this.animClock, dt = Math.min(.1, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;
    this.animQueue = this.animQueue.filter(cue => cue.end + 65 >= now);
    this.audioAnalyzerNode.getFloatTimeDomainData(this.samples);
    const rms = Math.sqrt(this.samples.reduce((sum, n) => sum + n * n, 0) / this.samples.length);
    const energy = clamp(rms * 12, 0, 1);
    let open = 0, form = this.moodName === 'happy' ? .85 : .65, weight = 0, speechForm = 0;
    if (this.isSpeaking) {
      for (const cue of this.animQueue) {
        const rise = clamp((now - cue.ts[0] + 25) / 45, 0, 1);
        const fall = clamp((cue.end + 45 - now) / 65, 0, 1);
        const influence = rise * fall;
        if (!influence) continue;
        const shape = SHAPES[cue.id] || SHAPES.aa;
        open += shape[0] * influence; speechForm += shape[1] * influence;
        weight += influence;
      }
      if (weight > 1) open /= weight;
      form = form * (1 - Math.min(1, weight)) + speechForm / Math.max(1, weight);
      if (!this.hasVisemes) open = energy * .6;
      // Silence closes the mouth even if the aligner's final cue extends into it.
      open *= clamp(energy * 4, 0, 1);
    }
    // Let the mouth settle softly at pauses instead of snapping shut.
    const blend = 1 - Math.exp(-dt / (open < this.open ? .095 : .045));
    this.open += (clamp(open, 0, .82) - this.open) * blend;
    this.form += (clamp(form, -.9, .85) - this.form) * blend;
    if (now >= this.nextBlink) {
      this.blinkStart = now;
      this.nextBlink = now + 3200 + Math.random() * 2600;
    }
    const blinkElapsed = now - this.blinkStart;
    const blink = blinkElapsed < 95 ? 1 - blinkElapsed / 95 : blinkElapsed < 220 ? (blinkElapsed - 95) / 125 : 1;
    const happy = this.moodName === 'happy';
    const values = {
      ParamMouthOpenY: this.open, ParamMouthForm: this.form,
      ParamEyeLOpen: blink, ParamEyeROpen: blink,
      ParamEyeLSmile: happy ? .12 : .04, ParamEyeRSmile: happy ? .12 : .04,
      ParamBrowLY: happy ? .08 : .03, ParamBrowRY: happy ? .08 : .03,
      ParamBrowLAngle: 0, ParamBrowRAngle: 0, ParamBrowLForm: .05, ParamBrowRForm: .05,
      ParamTere: 0, ParamTear: 0, ParamFaceForm: 0, ParamEyeForm: 0,
    };
    for (const [id, value] of Object.entries(values)) this.parameter(id, value);
    // Use the relaxed arm artwork, not the sample's default folded arms.
    for (const side of ['L', 'R']) for (const variant of ['A', 'B']) {
      const id = `Part01Arm${side}${variant}001`;
      if (this.partIds.has(id)) this.core.setPartOpacityById(id, variant === 'A' ? 1 : 0);
    }
    this.stats.frames++;
    this.stats.mouthMax = Math.max(this.stats.mouthMax, this.open);
    this.stats.lastParameters = { ...this.poseValues, ...values };
  }
  _processLipsyncData(data, offset) {
    this.hasVisemes = true;
    data.visemes.forEach((id, index) => {
      const start = offset + data.vtimes[index], duration = data.vdurations[index];
      if (!this.animQueue.some(c => c.id === id && Math.abs(c.ts[0] - start) < 8)) {
        this.animQueue.push({ id, ts: [start], end: start + duration, template: { name: 'viseme' } });
      }
      if (!this.stats.visemes.includes(id)) this.stats.visemes.push(id);
    });
  }
  resetLips() { this.animQueue = []; this.hasVisemes = false; }
  setInteractionState(state) { this.stateName = state; }
  setMood(mood) { this.moodName = mood === 'happy' ? 'happy' : 'neutral'; }
  lookAtCamera(ms = 2000) { this.eyeContactUntil = this.animClock + ms; }
  speakWithHands() { this.playGesture('explain', 2.8); }
  playGesture(name, duration = 2.5) { this.gesture = { name, start: this.animClock, duration: duration * 1000 }; }
  stopGesture() { this.gesture = null; }
  start() { this.isRunning = true; this.lastUpdate = this.animClock; this.fit(); this.app.start(); }
  stop() { this.isRunning = false; this.app?.stop(); }
  stopSpeaking() {
    this.currentSpeech?.stop();
    for (const source of this.legacySources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    this.legacySources.clear();
    for (const timer of this.legacyTimers) clearTimeout(timer);
    this.legacyTimers.clear(); this.legacyEnd = 0;
    this.isSpeaking = false; this.isStreaming = false; this.stateName = 'idle'; this.resetLips();
  }
  speakAudio(data) {
    // Compatibility with whole-WAV replies; current server uses ContinuousSpeech.
    const source = this.audioCtx.createBufferSource(); source.buffer = data.audio;
    source.connect(this.audioAnalyzerNode); this.legacySources.add(source);
    const start = Math.max(this.audioCtx.currentTime, this.legacyEnd || 0);
    const offset = (start - this.audioCtx.currentTime) * 1000;
    this.legacyEnd = start + data.audio.duration;
    this.isSpeaking = true;
    this._processLipsyncData(data, this.animClock + offset);
    data.markers?.forEach((fn, i) => {
      const timer = setTimeout(() => { this.legacyTimers.delete(timer); fn(); }, offset + data.mtimes[i]);
      this.legacyTimers.add(timer);
    });
    source.onended = () => { this.legacySources.delete(source); source.disconnect(); if (!this.legacySources.size) { this.isSpeaking = false; this.resetLips(); } };
    source.start(start);
  }
  dispose() {
    this.stopSpeaking(); this.stop(); this.observer?.disconnect();
    this.audioAnalyzerNode.disconnect(); this.gain.disconnect();
    this.model?.destroy({ children: true, texture: true, baseTexture: true });
    this.app?.destroy(true);
  }
}
