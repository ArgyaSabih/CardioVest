import { clock, LOG_TAGS } from "./labels.js";

export function createLog(list, max = 80) {
  let empty = true;
  return {
    add(kind, text) {
      if (empty) {
        list.textContent = "";
        empty = false;
      }
      const [label, tone] = LOG_TAGS[kind] ?? [kind, "info"];
      const li = document.createElement("li");
      const time = document.createElement("time");
      time.textContent = clock(Date.now());
      const tag = document.createElement("span");
      tag.className = "log-tag";
      tag.dataset.tone = tone;
      tag.textContent = label;
      const body = document.createElement("span");
      body.textContent = text;
      li.append(time, tag, body);
      list.prepend(li);
      while (list.children.length > max) list.lastChild.remove();
    },
  };
}
