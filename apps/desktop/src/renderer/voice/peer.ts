/**
 * `RTCPeerConnection`, as `@riki/realtime`'s `PeerConnectionLike`.
 *
 * The negotiation sequence itself — data channel before the offer, POST the SDP, set the answer —
 * is `transport.ts`'s and is asserted there against a fake. This file only turns event-target
 * callbacks into the subscriber shape that package expects, which is why it has no logic in it and
 * should stay that way.
 *
 * Two details that are not free choices:
 *
 * - **No ICE servers.** The API's `/v1/realtime/calls` endpoint answers with a server-reflexive
 *   candidate and Riki is a client on a normal network; a STUN list here would be cargo.
 * - **`addTransceiver` is not used.** `addTrack` on the outbound track is enough, and the remote
 *   track arrives on `ontrack` because the answer includes it.
 */

import type {
  DataChannelLike,
  OutboundTrack,
  PeerConnectionLike,
  RemoteTrack,
  Unsubscribe,
} from '@riki/realtime';

function channelFor(channel: RTCDataChannel): DataChannelLike {
  return {
    send(payload: string): void {
      // `readyState` is checked by the transport's own state machine; a send before open throws
      // here and is caught there. Not swallowed: a dropped client event is a turn that hangs.
      channel.send(payload);
    },

    onMessage(listener): Unsubscribe {
      const handler = (event: MessageEvent<unknown>): void => {
        if (typeof event.data === 'string') listener(event.data);
      };
      channel.addEventListener('message', handler);
      return () => {
        channel.removeEventListener('message', handler);
      };
    },

    onOpen(listener): Unsubscribe {
      const handler = (): void => {
        listener();
      };
      channel.addEventListener('open', handler);
      return () => {
        channel.removeEventListener('open', handler);
      };
    },

    close(): void {
      channel.close();
    },
  };
}

export function createBrowserPeerConnection(): PeerConnectionLike {
  const peer = new RTCPeerConnection();

  return {
    createDataChannel(label: string): DataChannelLike {
      return channelFor(peer.createDataChannel(label));
    },

    async createOffer(): Promise<{ readonly sdp: string }> {
      const offer = await peer.createOffer();
      return { sdp: offer.sdp ?? '' };
    },

    async setLocalDescription(offer: { readonly sdp: string }): Promise<void> {
      await peer.setLocalDescription({ type: 'offer', sdp: offer.sdp });
    },

    async setRemoteDescription(answer: {
      readonly type: 'answer';
      readonly sdp: string;
    }): Promise<void> {
      await peer.setRemoteDescription(answer);
    },

    addTrack(track: OutboundTrack): void {
      const real = track as unknown as MediaStreamTrack;
      peer.addTrack(real, new MediaStream([real]));
    },

    onTrack(listener: (track: RemoteTrack) => void): Unsubscribe {
      const handler = (event: RTCTrackEvent): void => {
        listener(event.track);
      };
      peer.addEventListener('track', handler);
      return () => {
        peer.removeEventListener('track', handler);
      };
    },

    onConnectionStateChange(listener: (state: string) => void): Unsubscribe {
      const handler = (): void => {
        listener(peer.connectionState);
      };
      peer.addEventListener('connectionstatechange', handler);
      return () => {
        peer.removeEventListener('connectionstatechange', handler);
      };
    },

    close(): void {
      peer.close();
    },
  };
}
