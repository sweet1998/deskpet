import { useDeskpetStore } from '@/stores/deskpet'
import { playMotion } from '@/services/live2d/loader'

export enum MotionLayer {
  Idle = 1,
  Reply = 2,
  Interaction = 3,
}

export function useMotionPriority(store: ReturnType<typeof useDeskpetStore>) {
  let currentLayer: MotionLayer | null = null

  function playMotionWithPriority(
    motion: string,
    layer: MotionLayer,
    index: number = 0,
  ): boolean {
    if (currentLayer !== null && layer < currentLayer) return false

    const model = store.live2dModel
    if (!model) return false

    currentLayer = layer
    playMotion(model, motion, index)

    if (layer !== MotionLayer.Idle) {
      setTimeout(() => {
        if (currentLayer === layer) {
          currentLayer = null
        }
      }, 5000)
    }

    return true
  }

  function releaseIdle() {
    if (currentLayer === MotionLayer.Idle) {
      currentLayer = null
    }
  }

  return { playMotionWithPriority, releaseIdle }
}
