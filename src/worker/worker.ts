import workerpool from 'workerpool'

import { prepareMsfsGltfLod } from './tasks/prepareMsfsGltfLod'
import { toCreasedNormals } from './tasks/toCreasedNormals'

export const methods = { prepareMsfsGltfLod, toCreasedNormals }

workerpool.worker(methods)
