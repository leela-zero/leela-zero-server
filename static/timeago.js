// Largest value for each desired time unit
var TIME_UNITS = [
  [1000, "milliseconds"],
  [60, "seconds"],
  [60, "minutes"],
  [24, "hours"],
  [7, "days"],
  [52 / 12, "weeks"],
  [12, "months"],
  [Infinity, "years"]
];

/**
 * Convert some time delta in milliseconds into "ago" string with largest appropriate units.
 */
function deltaToAgo(delta) {
  if (Number.isNaN(delta)) {
    return "";
  }
  var unitIndex = 0;
  while (unitIndex < TIME_UNITS.length) {
    var divisor = TIME_UNITS[unitIndex][0];
    if (delta < divisor) {
      break;
    }
    delta /= divisor;
    unitIndex++; 
  }
  return delta.toFixed(1) + " " + TIME_UNITS[unitIndex][1] + " ago";
}

// Add an ago tooltip to show on hover for each date <td>
addEventListener("mouseover", function(event) {
  var td = event.target;
  var match = td.textContent.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/);
  if (td.nodeName == "TD" && match) {
    td.classList.add("tooltip");
    var tooltip = td.lastChild;
    if (tooltip.nodeName == "#text") {
      tooltip = td.appendChild(document.createElement("span"));
      tooltip.classList.add("tooltiptextright");
    }
    tooltip.textContent = deltaToAgo(Date.now() - new Date(match[0] + ":00+0100"));
  }
});

