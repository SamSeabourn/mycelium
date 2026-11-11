import { Button } from './Button';
import { cn } from '../lib/utils';
export default function Card() {
  return <div className={cn('card')}><Button label="hi" /></div>;
}
