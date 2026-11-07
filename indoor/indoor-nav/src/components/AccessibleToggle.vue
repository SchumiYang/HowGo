<script setup lang="ts">
const model = defineModel<boolean>({ required: true })
</script>

<template>
  <label class="toggle">
    <span class="txt">
      <span class="title">無障礙路線</span>
      <span class="sub">{{ model ? '只走電梯與無階梯通道' : '可能經過樓梯' }}</span>
    </span>
    <input v-model="model" type="checkbox" role="switch" :aria-checked="model" />
    <span class="track" aria-hidden="true"></span>
  </label>
</template>

<style scoped>
.toggle {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  cursor: pointer;
}
.txt {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.title {
  font-weight: 600;
}
.sub {
  font-size: 14px;
  color: var(--tp-grayscale700);
}
input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}
.track {
  position: relative;
  flex: none;
  width: 52px;
  height: 32px;
  border-radius: 16px;
  background: var(--tp-grayscale500);
  transition: background 0.15s;
}
.track::after {
  content: '';
  position: absolute;
  top: 4px;
  left: 4px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--tp-white);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform 0.15s;
}
input:checked + .track {
  background: var(--tp-primary700);
}
input:checked + .track::after {
  transform: translateX(20px);
}
input:focus-visible + .track {
  outline: 3px solid var(--tp-primary700);
  outline-offset: 2px;
}
</style>
