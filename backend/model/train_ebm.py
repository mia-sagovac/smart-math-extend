import argparse
import json
import numpy as np
import pandas as pd
import joblib
from pathlib import Path

from sklearn.model_selection import train_test_split
from sklearn.metrics import (
    classification_report,
    confusion_matrix,
    accuracy_score,
    f1_score,
    balanced_accuracy_score,
)
from interpret.glassbox import ExplainableBoostingClassifier

FEATURES = ["accuracy", "avg_time", "hints_used"]
CLASSES = [0, 1, 2]


def load_data(csv_path: str):
    df = pd.read_csv(csv_path)
    df = df.replace([np.inf, -np.inf], np.nan).dropna()
    X = df[FEATURES].copy()
    y = df["label"].astype(int)
    return X, y


def main(args):
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading data from: {args.csv}")
    X, y = load_data(args.csv)
    print(f"Samples: {len(X)}  |  Class distribution: {y.value_counts().sort_index().to_dict()}")

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=args.test_size, random_state=args.seed, stratify=y
    )

    print("Training EBM …")
    model = ExplainableBoostingClassifier(
        random_state=args.seed,
        n_jobs=1,
        interactions=0,
    )
    model.fit(X_train, y_train)

    # Evaluation
    y_pred = model.predict(X_test)
    y_proba = model.predict_proba(X_test)

    acc = accuracy_score(y_test, y_pred)
    macro_f1 = f1_score(y_test, y_pred, average="macro")
    bal_acc = balanced_accuracy_score(y_test, y_pred)
    report = classification_report(y_test, y_pred, output_dict=True)
    conf = confusion_matrix(y_test, y_pred).tolist()

    eval_summary = {
        "accuracy": acc,
        "macro_f1": macro_f1,
        "balanced_accuracy": bal_acc,
        "confusion_matrix": conf,
        "classification_report": report,
    }
    eval_path = out_dir / "ebm_evaluation.json"
    with open(eval_path, "w") as f:
        json.dump(eval_summary, f, indent=2)

    # Save test predictions for inspection
    test_out = X_test.copy()
    test_out["y_true"] = list(y_test)
    test_out["y_pred"] = list(y_pred)
    for i in range(y_proba.shape[1]):
        test_out[f"prob_class_{i}"] = y_proba[:, i]
    test_out.to_csv(out_dir / "ebm_test_predictions.csv", index=False)

    # Save model
    model_path = out_dir / "ebm_model.joblib"
    joblib.dump(model, model_path)

    print(f"\nAccuracy:          {acc:.4f}")
    print(f"Macro F1:          {macro_f1:.4f}")
    print(f"Balanced accuracy: {bal_acc:.4f}")
    print(f"\nModel saved  → {model_path}")
    print(f"Evaluation   → {eval_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train EBM for difficulty prediction")
    parser.add_argument("--csv", default="model/train_dataset.csv")
    parser.add_argument("--output_dir", default="model/model_output")
    parser.add_argument("--test_size", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    main(args)