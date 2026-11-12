export class CameraPeers {
  constructor({ send, diagnostic, state, receiveAudio = () => {}, closed = () => {}, configuration = async () => ({ iceServers: [] }) }) { this.send = send; this.diagnostic = diagnostic; this.state = state; this.receiveAudio = receiveAudio; this.closed = closed; this.configuration = configuration; this.peers = new Map(); }
  close(id) { const p = this.peers.get(id); if (p) { p.pc?.close(); this.peers.delete(id); this.closed(id); } }
  closeAll() { for (const id of this.peers.keys()) this.close(id); }
  async offer(id, stream) {
    this.close(id);
    const item = { pc: null, candidates: [] }; this.peers.set(id, item);
    const configuration = await this.configuration(); if (this.peers.get(id) !== item) return;
    const pc = new RTCPeerConnection(configuration); item.pc = pc;
    stream.getTracks().forEach(t => { const sender = pc.addTrack(t, stream); if (t.kind === 'audio') item.audioSender = sender; else if (t.kind === 'video') item.videoSender = sender; });
    // Keep an audio sender negotiated so microphone toggles do not interrupt video or recordings.
    item.audioSender ??= pc.addTransceiver('audio', { direction: 'sendrecv', streams: [stream] }).sender;
    pc.ontrack = event => { if (this.peers.get(id) === item) this.receiveAudio(id, event.track); };
    pc.onicecandidate = e => { if (e.candidate && this.peers.get(id) === item) this.send({ type: 'candidate', peerId: id, candidate: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(id) !== item) return;
      this.diagnostic('视频连接', pc.connectionState); this.state(pc.connectionState, this.peers.size);
    };
    await pc.setLocalDescription(await pc.createOffer());
    if (this.peers.get(id) === item) this.send({ type: 'offer', peerId: id, sdp: pc.localDescription });
  }
  async answer(id, sdp) { const p = this.peers.get(id); if (!p?.pc) return; await p.pc.setRemoteDescription(sdp); for (const c of p.candidates.splice(0)) await p.pc.addIceCandidate(c); }
  async replaceAudioTrack(track) {
    await Promise.all([...this.peers].map(async ([id, item]) => {
      try { await item.audioSender?.replaceTrack(track); }
      catch (error) { if (this.peers.get(id) === item && item.pc?.signalingState !== 'closed') throw error; }
    }));
  }
  async replaceVideoTrack(track, stream) {
    await Promise.all([...this.peers].map(async ([id, item]) => {
      try { await item.videoSender?.replaceTrack(track); }
      catch (error) {
        if (this.peers.get(id) !== item || item.pc?.signalingState === 'closed') return;
        try { await this.offer(id, stream); }
        catch (failure) { this.diagnostic('画面更新', failure.message); }
      }
    }));
  }
  async candidate(id, candidate) { const p = this.peers.get(id); if (!p) return; if (p.pc?.remoteDescription) await p.pc.addIceCandidate(candidate); else if (p.candidates.length < 100) p.candidates.push(candidate); }
}
