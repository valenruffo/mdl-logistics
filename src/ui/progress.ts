/**
 * The run's fixed journey, as the UI shows it while the panel walk is in flight.
 *
 * The journey behind these lists is `src/executor/run.ts` (read-only for the UI):
 * domicilio walks screens 1–4 and clicks `Crear envío` on the summary; sucursal
 * enters through the agency URL, walks screens P–Q and clicks on screen Q. The
 * UI cannot know where the walk is right now — the HTTP flow is one POST that
 * answers at the end — so the card that renders these steps while the request is
 * in flight is **an estimate**: it advances on a timer over the known step
 * count, is labelled `estimado`/`aproximado`, and snaps to the response's real
 * outcome when the POST returns. Honesty over theater: the timer never marks the
 * last step as done, and nothing on screen says "creado" before the response
 * says so.
 *
 * The step counts are pinned by `tests/unit/ui-progress.test.ts`, which renders
 * the real client script against a fake DOM for both modalities.
 */
import type { MessageModality } from '../core/types';

/** One label per journey step, in panel order, written for the operator. */
export const JOURNEY_STEPS: Record<MessageModality, readonly string[]> = {
  domicilio: [
    'Abriendo el panel…',
    'Cargando destinatario y paquete…',
    'Cotizando el envío…',
    'Escribiendo los datos del destinatario…',
    'Revisando el resumen…',
    'Creando el envío…',
    'Confirmando que la etiqueta sigue impaga…',
  ],
  sucursal: [
    'Abriendo el panel…',
    'Cargando destinatario y paquete…',
    'Cotizando el envío…',
    'Seleccionando Andreani a sucursal…',
    'Seleccionando la sucursal…',
    'Creando el envío…',
  ],
};

/**
 * The approximate percentage the in-flight card shows, from completed steps.
 *
 * Steps are near-equal in duration, so `completed / total` is an estimate, not a
 * measurement — the UI says so next to the number. The result is **capped below
 * 100**: only the POST's response can say the run is done, and a timer must
 * never claim it.
 */
export function approximatePercent(completedSteps: number, totalSteps: number): number {
  if (totalSteps <= 0) return 0;
  const capped = Math.min(Math.max(completedSteps, 0), totalSteps - 1);
  return Math.round((capped / totalSteps) * 100);
}
