import { AppContext, createAppContext } from 'nfkit';
import { CDeckService } from './c-deck.service';

export const CDeckModule = createAppContext()
  .provide(CDeckService)
  .define();
