function hasPresentValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function getReviewFieldSummaryStatus(field) {
  const normalizedField = field && typeof field === "object" ? field : {};
  const currentPresent = hasPresentValue(normalizedField.current);
  const suggestionPresent = hasPresentValue(normalizedField.suggestion);

  if (!suggestionPresent) {
    return "unavailable";
  }

  if (!currentPresent) {
    return "suggested";
  }

  return normalizedField.changed ? "different" : "same";
}

function getSummaryMessage({ suggested, different }) {
  if (different > 0) {
    return "Review the highlighted differences before applying suggestions.";
  }

  if (suggested > 0) {
    return "AI found additional information that can be applied.";
  }

  return "No conflicts were found.";
}

export function buildReceiptReviewSummary(reviewModel) {
  const fields = reviewModel && typeof reviewModel === "object" && reviewModel.fields && typeof reviewModel.fields === "object"
    ? reviewModel.fields
    : {};
  const summary = {
    same: 0,
    suggested: 0,
    different: 0,
    hasConflicts: false,
    message: "",
  };

  for (const field of Object.values(fields)) {
    const status = getReviewFieldSummaryStatus(field);

    if (status === "same") {
      summary.same += 1;
    } else if (status === "suggested") {
      summary.suggested += 1;
    } else if (status === "different") {
      summary.different += 1;
    }
  }

  summary.hasConflicts = summary.different > 0;
  summary.message = getSummaryMessage(summary);
  return summary;
}
