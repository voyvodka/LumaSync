import { WledDevicePicker } from "../WledDevicePicker";

export interface WledCategoryProps {
  isActive: boolean;
}

export function WledCategory({ isActive }: WledCategoryProps) {
  return (
    <div className={isActive ? "lm-device-cat-body" : "lm-device-cat-body hidden"} hidden={!isActive}>
      <WledDevicePicker />
    </div>
  );
}
