import type { Consumer } from 'kafkajs';

export interface ConsumerReadinessStatus {
  joined: boolean;
  crashed: boolean;
  ready: boolean;
}

/**
 * Estado del consumidor para /ready, con los eventos instrumentados de kafkajs (mismo
 * criterio que `KafkaReadiness` de services/judge).
 */
export class ConsumerReadiness {
  joined = false;
  crashed = false;

  track(consumer: Consumer): void {
    consumer.on(consumer.events.GROUP_JOIN, () => {
      this.joined = true;
      this.crashed = false;
    });
    consumer.on(consumer.events.CRASH, () => (this.crashed = true));
    consumer.on(consumer.events.STOP, () => (this.joined = false));
    consumer.on(consumer.events.DISCONNECT, () => (this.joined = false));
  }

  status(): ConsumerReadinessStatus {
    return { joined: this.joined, crashed: this.crashed, ready: this.joined && !this.crashed };
  }
}
