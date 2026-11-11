import { cn } from '@/lib/utils';
export const Button = ({ label }: { label: string }) => {
  return <button className={cn('btn')}>{label}</button>;
};
