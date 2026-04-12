import joblib
import pandas as pd
from pathlib import Path

MODEL_PATH = Path(__file__).resolve().parents[2] / "model" / "model_output" / "decision_tree.joblib"

FEATURES = ["accuracy", "avg_time", "hints_used"]

_dt_model = None


def get_decision_tree():
    global _dt_model
    if _dt_model is None:
        if not MODEL_PATH.exists():
            raise RuntimeError(
                f"Decision tree model not found at {MODEL_PATH}. "
                "Train it first: python model/train_decision_tree.py"
            )
        _dt_model = joblib.load(MODEL_PATH)
    return _dt_model


def predict_decision_tree(accuracy: float, avg_time: float, hints_used: int) -> dict:
    model = get_decision_tree()

    X = pd.DataFrame([{
        "accuracy": accuracy,
        "avg_time": avg_time,
        "hints_used": hints_used,
    }])[FEATURES]

    prediction = int(model.predict(X)[0])
    explanation = _walk_tree(model, X)

    label_map = {0: "smanjiti težinu", 1: "zadržati isti level", 2: "povećati težinu"}

    return {
        "next_difficulty": prediction,
        "label_text": label_map.get(prediction, str(prediction)),
        "reason": explanation,
        "algorithm": "decision_tree",
    }


def _walk_tree(model, X: pd.DataFrame) -> str:
    nice_names = {
        "accuracy":   "postotak točnih rješenja",
        "avg_time":   "prosječno vrijeme rješavanja",
        "hints_used": "broj korištenih pomoći",
    }

    tree = model.tree_
    feature_names = list(model.feature_names_in_) if hasattr(model, "feature_names_in_") else FEATURES

    node = 0
    reasons = []
    while tree.children_left[node] != tree.children_right[node]:  # not a leaf
        feat_idx = tree.feature[node]
        threshold = tree.threshold[node]
        feat_name = feature_names[feat_idx]
        value = float(X.iloc[0, feat_idx])
        display = nice_names.get(feat_name, feat_name)

        if value <= threshold:
            reasons.append(f"{display} je ≤ {threshold:.2f}")
            node = tree.children_left[node]
        else:
            reasons.append(f"{display} je > {threshold:.2f}")
            node = tree.children_right[node]

    return "Stablo odluke: " + ", zatim ".join(reasons) + "."